// burst.js — захват СЕРИИ кадров одним ffmpeg-подключением.
// Вместо одного снапшота берём 8 кадров за ~2 сек → у анализа действий
// появляется реальное время (dt≈0.25с), а NVR получает одно RTSP-подключение
// вместо четырёх (RAPID раньше дёргал grabSnapshot повторно).

import { spawn } from 'child_process';
import { readFile, unlink, readdir } from 'fs/promises';

/**
 * @param {string} inputUrl  rtsp://... (или путь к файлу — для тестов)
 * @param {string|number} cameraId
 * @param {object} opts { frames=8, fps=4, timeoutMs }
 * @returns {Promise<{buffers: Buffer[], timestamps: number[]}>} кадры + оценка времени каждого
 */
export function grabBurst(inputUrl, cameraId, opts = {}) {
  const frames = Math.max(2, opts.frames ?? 8);
  const fps = Math.max(1, opts.fps ?? 4);
  const timeoutMs = opts.timeoutMs ?? Math.ceil((frames / fps) * 1000) + 20000;
  const stamp = Date.now();
  const pattern = `/tmp/burst_${cameraId}_${stamp}_%02d.jpg`;
  const prefix = `burst_${cameraId}_${stamp}_`;

  return new Promise((resolve, reject) => {
    const isRtsp = inputUrl.startsWith('rtsp://');
    const args = [
      ...(isRtsp ? ['-rtsp_transport', 'tcp'] : []),
      '-i', inputUrl,
      '-vf', `fps=${fps}`,
      '-frames:v', String(frames),
      '-q:v', '5',
      '-y', pattern,
    ];
    const t0 = Date.now();
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', c => { stderr += c.toString(); });
    const timer = setTimeout(() => { ff.kill('SIGKILL'); }, timeoutMs);

    ff.on('close', async () => {
      clearTimeout(timer);
      try {
        const files = (await readdir('/tmp'))
          .filter(f => f.startsWith(prefix))
          .sort();
        if (files.length < 2) {
          for (const f of files) await unlink('/tmp/' + f).catch(() => {});
          return reject(new Error(`burst: получено ${files.length} кадров: ${stderr.split('\n').slice(-3).join(' ').slice(-180)}`));
        }
        const buffers = [];
        for (const f of files) {
          buffers.push(await readFile('/tmp/' + f));
          await unlink('/tmp/' + f).catch(() => {});
        }
        // временные метки: старт захвата + i/fps (ffmpeg отдаёт кадры равномерно по фильтру fps)
        const timestamps = buffers.map((_, i) => t0 + Math.round((i * 1000) / fps));
        resolve({ buffers, timestamps });
      } catch (e) { reject(e); }
    });
    ff.on('error', e => { clearTimeout(timer); reject(e); });
  });
}
