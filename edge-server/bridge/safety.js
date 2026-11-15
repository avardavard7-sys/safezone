// safety.js — защита бриджа от отказов в реальной работе:
// зависшие внешние программы, запросы без ответа, наложение проходов цикла,
// необработанные ошибки и часы сервера в другом часовом поясе.

import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/** Путь к ffmpeg: в приложении он лежит внутри программы, а не в системе. */
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** Необработанная ошибка в фоновой задаче не должна останавливать бридж. */
export function installProcessGuards(log = console.log) {
  process.on('unhandledRejection', (reason) => {
    log(`⚠️ необработанная ошибка в фоне: ${reason?.stack || reason}`);
  });
  process.on('uncaughtException', (err) => {
    log(`⚠️ непойманная ошибка: ${err?.stack || err}`);
  });
}

/**
 * Обёртка «один проход за раз». Если предыдущий запуск ещё не закончился,
 * новый пропускается, а не идёт поверх: иначе камеры обрабатываются дважды,
 * тревоги дублируются, а проходы копятся.
 */
export function singleFlight(fn, { onSkip = () => {}, onError = () => {} } = {}) {
  let busy = false;
  let skipped = 0;
  const run = async (...args) => {
    if (busy) { skipped++; onSkip(skipped); return false; }
    busy = true;
    try { await fn(...args); }
    catch (e) { onError(e); }
    finally { busy = false; skipped = 0; }
    return true;
  };
  run.isBusy = () => busy;
  return run;
}

/** Часы объекта, а не сервера: сервер может стоять в другой стране. */
export function localClock(tz = 'Asia/Almaty', date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find(p => p.type === 'hour').value) % 24;
  const minute = Number(parts.find(p => p.type === 'minute').value);
  return { hour, minute, minutes: hour * 60 + minute };
}

/** Попадает ли момент в интервал «ЧЧ:ММ–ЧЧ:ММ» по часам объекта. Интервал может идти через полночь. */
export function withinHours(start, end, tz = 'Asia/Almaty', date = new Date()) {
  const toMin = (v) => {
    const [h, m] = String(v ?? '').split(':').map(Number);
    return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : NaN;
  };
  const s = toMin(start), e = toMin(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  const cur = localClock(tz, date).minutes;
  return s > e ? (cur >= s || cur < e) : (cur >= s && cur < e);
}

export function localTime(tz = 'Asia/Almaty', date = new Date()) {
  return date.toLocaleTimeString('ru-RU', { timeZone: tz });
}

/** Сетевой запрос, который не может висеть бесконечно. */
export function fetchWithTimeout(url, opts = {}, ms = 15000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

/** Путь для временного снимка: работает и на Linux, и на Windows. */
export function tmpSnapshotPath(cameraId) {
  const safe = String(cameraId ?? 'cam').replace(/[^\w-]/g, '_');
  return join(tmpdir(), `snap_${safe}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
}

/**
 * Насколько два кадра отличаются, в процентах (0 — одинаковые).
 * Любой сбой ffmpeg — нет программы, зависла, закрылась раньше времени —
 * возвращает 100 («считать кадры разными») и не роняет процесс.
 */
export function frameDiff(buf1, buf2, { timeoutMs = 10000, bin = FFMPEG } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    try {
      const ff = spawn(bin, [
        '-i', 'pipe:3', '-i', 'pipe:4',
        '-filter_complex', 'ssim', '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
      let stderr = '';
      ff.on('error', () => finish(100));
      ff.on('close', () => {
        const m = stderr.match(/All:\s*([0-9.]+)/);
        finish(m ? (1 - parseFloat(m[1])) * 100 : 100);
      });
      timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} finish(100); }, timeoutMs);
      if (ff.stderr) { ff.stderr.on('data', (d) => { stderr += d.toString(); }); ff.stderr.on('error', () => {}); }
      for (const i of [3, 4]) {
        const pipe = ff.stdio?.[i];
        if (!pipe) continue;
        pipe.on('error', () => {});
        pipe.end(i === 3 ? buf1 : buf2);
      }
    } catch { finish(100); }
  });
}

/** Протоколы, которые ffmpeg может открыть по адресу камеры. Файлы, http и прочее закрыты. */
export const CAMERA_PROTOCOLS = 'rtsp,rtsps,rtp,srtp,udp,tcp,tls';

/** Адрес камеры — только rtsp:// или rtsps://. Иначе ffmpeg можно заставить прочитать файл компьютера. */
export function isCameraUrl(url) {
  return typeof url === 'string' && /^rtsps?:\/\/[^\s]+$/i.test(url.trim());
}

/** Убирает логины, пароли и токены из текста: ffmpeg печатает адрес камеры целиком прямо в ошибке. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@'"]+@/gi, '$1***@')
    .replace(/([?&](?:password|pass|pwd|token|jwt|key)=)[^&\s'"]+/gi, '$1***');
}

/** Один кадр с камеры. Только протоколы камер, без утечки пароля в ошибке, с таймаутом. */
export function grabSnapshot(rtspUrl, cameraId, { bin = FFMPEG, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!isCameraUrl(rtspUrl)) { reject(new Error('адрес камеры должен начинаться с rtsp://')); return; }
    const tmpFile = tmpSnapshotPath(cameraId);
    const args = ['-protocol_whitelist', CAMERA_PROTOCOLS, '-rtsp_transport', 'tcp', '-i', rtspUrl, '-frames:v', '1', '-q:v', '5', '-y', tmpFile];
    let stderr = '', done = false, timer = null;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    let ff;
    try { ff = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { finish(reject, new Error(redactSecrets(e.message))); return; }
    ff.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-4000); });
    timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} finish(reject, new Error('timeout')); }, timeoutMs);
    ff.on('error', e => finish(reject, new Error(redactSecrets(e.message))));
    ff.on('close', async (code) => {
      try {
        if (code === 0) {
          const buf = await readFile(tmpFile);
          await unlink(tmpFile).catch(() => {});
          finish(resolve, buf);
        } else {
          await unlink(tmpFile).catch(() => {});
          finish(reject, new Error(redactSecrets(`exit ${code}: ${stderr.split('\n').slice(-3).join(' ').slice(-200)}`)));
        }
      } catch (e) { finish(reject, new Error(redactSecrets(e.message))); }
    });
  });
}
