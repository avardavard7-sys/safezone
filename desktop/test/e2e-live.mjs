// Сквозная проверка живого видео: поддельная камера → локальный видеосервер → бридж и браузер приложения.
// Запуск: SZ_MEDIAMTX=/путь/к/mediamtx SZ_ELECTRON=/путь/к/electron node e2e-live.mjs
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const media = require('../media.js');
const sharp = createRequire(new URL('../../edge-server/bridge/package.json', import.meta.url))('sharp');
const MTX = process.env.SZ_MEDIAMTX, ELECTRON = process.env.SZ_ELECTRON;
if (!MTX || !ELECTRON) { console.log('нужны SZ_MEDIAMTX и SZ_ELECTRON'); process.exit(2); }

const P = { cam: 19554, bridge: 18099, dash: 18300, api: 19997, rtsp: 18554, webrtc: 18889, ice: 18189 };
const DASH = `http://127.0.0.1:${P.dash}`;
process.env.PANEL_ORIGINS = DASH;
const { startApi } = await import('../../edge-server/bridge/api.js');
const { loadKey, MediaSync, internalReadUrl, localLiveSession, pathFor } = await import('../../edge-server/bridge/media.js');
const { grabSnapshot } = await import('../../edge-server/bridge/safety.js');

let passed = 0, failed = 0;
const ok = (n, c, e = '') => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} ${e}`); } };
const info = (t) => console.log(`  ·    ${t}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const procs = [];
const run = (bin, args, opts = {}) => { const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }); procs.push(p); p.log = ''; const add = d => { p.log = (p.log + d).slice(-6000); }; p.stdout.on('data', add); p.stderr.on('data', add); return p; };
const cleanup = () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } };
process.on('exit', cleanup);

const dir = mkdtempSync(join(tmpdir(), 'sz-e2e-'));
const CAM = '11111111-2222-4333-8444-555555555555';
const secrets = media.ensureMediaSecrets(dir);
const key = loadKey(secrets.privateKeyPem);
const mediaState = { enabled: true, whep: `http://127.0.0.1:${P.webrtc}`, key };
let access = { allowed: true };

console.log('\nПодготовка');
// 1. поддельная камера: отдельный RTSP-сервер и движущаяся картинка H.264
writeFileSync(join(dir, 'cam.yml'), `logLevel: warn\napi: false\nrtsp: true\nrtspAddress: 127.0.0.1:${P.cam}\nrtmp: false\nhls: false\nwebrtc: false\nsrt: false\nmoq: false\npaths:\n  all_others:\n`);
run(MTX, [join(dir, 'cam.yml')]);
await sleep(1200);
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-tune', 'zerolatency', '-g', '15', '-bf', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${P.cam}/cam`]);

// 2. API бриджа: права видеосервера и выдача пропусков
startApi({
  version: 'e2e', log: () => {}, media: { key, bridgeSecret: secrets.secret },
  liveSession: (id) => localLiveSession({ media: mediaState, cameras: [{ id: CAM }], cameraId: id, access }),
  getStatus: () => ({}),
}, { port: P.bridge, host: '127.0.0.1' });

// 3. наш видеосервер с настройками из приложения
const cfg = media.mediamtxConfig({ bridgeApiPort: P.bridge, origins: [DASH], ports: P });
writeFileSync(join(dir, 'mediamtx.yml'), cfg);
const mtx = run(MTX, [join(dir, 'mediamtx.yml')]);
await sleep(2500);
ok('видеосервер запустился с настройками из приложения', mtx.exitCode === null, mtx.log.slice(-300));
{
  // открытые порты процесса читаем напрямую из системы (Linux)
  const fs = await import('fs');
  const addrs = [];
  try {
    const inodes = new Set();
    for (const fd of fs.readdirSync(`/proc/${mtx.pid}/fd`)) {
      try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${mtx.pid}/fd/${fd}`)); if (m) inodes.add(m[1]); } catch {}
    }
    const read = (file, proto, v6) => {
      let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
      for (const line of text.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || !inodes.has(f[9])) continue;
        if (proto === 'tcp' && f[3] !== '0A') continue;
        const [ipHex, portHex] = f[1].split(':');
        const ip = v6 ? (/^0+$/.test(ipHex) ? '::' : ipHex) : [6, 4, 2, 0].map(i => parseInt(ipHex.slice(i, i + 2), 16)).join('.');
        addrs.push(`${proto} ${ip}:${parseInt(portHex, 16)}`);
      }
    };
    read('/proc/net/tcp', 'tcp', false); read('/proc/net/udp', 'udp', false);
    read('/proc/net/tcp6', 'tcp', true); read('/proc/net/udp6', 'udp', true);
  } catch {}
  info(`видеосервер слушает: ${addrs.sort().join(', ') || 'не удалось определить'}`);
  ok('все порты видеосервера открыты только для этого компьютера', addrs.length >= 4 && addrs.every(x => / 127\.0\.0\.1:\d+$/.test(x)), addrs.join(', '));
}

// 4. бридж регистрирует камеру в видеосервере
const sync = new MediaSync({ apiBase: `http://127.0.0.1:${P.api}` });
let stats = null, syncErr = '';
try { stats = await sync.sync([{ id: CAM, ip_address: '10.0.0.5' }], () => `rtsp://127.0.0.1:${P.cam}/cam`); } catch (e) { syncErr = e.message; }
ok('бридж добавил камеру в видеосервер', stats && stats.added === 1, syncErr);

console.log('\nБридж берёт кадры через видеосервер');
{
  let buf = null, err = '';
  const t0 = Date.now();
  try { buf = await grabSnapshot(internalReadUrl(`rtsp://127.0.0.1:${P.rtsp}`, CAM, secrets.secret), 'e2e', { timeoutMs: 20000 }); } catch (e) { err = e.message; }
  const meta = buf ? await sharp(buf).metadata() : {};
  info(`кадр для анализа: ${meta.width}x${meta.height}, ${buf ? Math.round(buf.length / 1024) : 0} КБ, за ${Date.now() - t0} мс`);
  ok('кадр для анализа получен через видеосервер', meta.width === 640 && meta.height === 360, err);
  let denied = '';
  try { await grabSnapshot(internalReadUrl(`rtsp://127.0.0.1:${P.rtsp}`, CAM, 'чужой-секрет'), 'e2e', { timeoutMs: 8000 }); } catch (e) { denied = e.message; }
  ok('без секрета бриджа поток по RTSP не отдаётся', !!denied && !/чужой-секрет/.test(denied), denied);
  const pub = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=5', '-t', '2', '-c:v', 'libx264', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://bridge:${secrets.secret}@127.0.0.1:${P.rtsp}/${pathFor(CAM)}`]);
  const code = await new Promise(r => { pub.on('exit', r); setTimeout(() => r('timeout'), 8000); });
  ok('подменить видео камеры снаружи нельзя: публикация запрещена', code !== 0, String(code));
}

console.log('\nБраузер приложения показывает видео');
let result = null;
const page = `<!doctype html><meta charset="utf-8"><video autoplay muted playsinline></video><script>
(async () => {
  const out = { ua: navigator.userAgent.includes('SafeZoneBridge') };
  const BRIDGE = 'http://127.0.0.1:${P.bridge}', CAM = '${CAM}';
  const post = (u, h, b) => fetch(u, { method: 'POST', headers: h, body: b });
  try {
    const t0 = performance.now();
    const sres = await post(BRIDGE + '/live/session', { 'Content-Type': 'application/json' }, JSON.stringify({ camera_id: CAM }));
    out.sessionStatus = sres.status; const s = await sres.json(); out.local = s.local; out.whep = s.whepUrl;
    out.unknownCam = (await post(BRIDGE + '/live/session', { 'Content-Type': 'application/json' }, JSON.stringify({ camera_id: '99999999-2222-4333-8444-555555555555' }))).status;
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
    const v = document.querySelector('video'); pc.ontrack = e => { v.srcObject = e.streams[0]; };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(r => { if (pc.iceGatheringState === 'complete') return r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 1500); });
    const sdp = pc.localDescription.sdp;
    out.noToken = (await post(s.whepUrl, { 'Content-Type': 'application/sdp' }, sdp)).status;
    out.fakeToken = (await post(s.whepUrl, { 'Content-Type': 'application/sdp', Authorization: 'Bearer aaa.bbb.ccc' }, sdp)).status;
    out.otherCam = (await post(s.whepUrl.replace(/cam_[0-9a-f]+/, 'cam_' + '0'.repeat(32)), { 'Content-Type': 'application/sdp', Authorization: 'Bearer ' + s.token }, sdp)).status;
    const res = await post(s.whepUrl, { 'Content-Type': 'application/sdp', Authorization: 'Bearer ' + s.token }, sdp);
    out.whepStatus = res.status;
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    let frames = 0, w = 0, h = 0, first = 0;
    const t1 = performance.now();
    while (performance.now() - t1 < 25000 && frames < 30) {
      await new Promise(r => setTimeout(r, 250));
      (await pc.getStats()).forEach(st => { if (st.type === 'inbound-rtp' && st.kind === 'video') { frames = st.framesDecoded || 0; w = st.frameWidth; h = st.frameHeight; } });
      if (frames > 0 && !first) first = Math.round(performance.now() - t0);
    }
    out.frames = frames; out.size = w + 'x' + h; out.firstFrameMs = first; out.state = pc.connectionState;
    out.videoPlaying = v.videoWidth > 0 && !v.paused;
  } catch (e) { out.error = String(e && e.message || e); }
  await fetch('/result', { method: 'POST', body: JSON.stringify(out) });
})();
</script>`;
const dash = http.createServer((req, res) => {
  if (req.url === '/result') { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { try { result = JSON.parse(b); } catch { result = { error: 'битый ответ' }; } res.end('ok'); }); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
}).listen(P.dash, '127.0.0.1');
const browser = run('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', ELECTRON, '--no-sandbox', join(here, 'e2e-browser.cjs')], { env: { ...process.env, E2E_URL: DASH + '/', E2E_TIMEOUT: '60000' } });
for (let i = 0; i < 110 && !result; i++) await sleep(500);
if (!result) { result = { error: 'браузер не ответил' }; info(browser.log.slice(-400)); }
info(`ответ браузера: ${JSON.stringify(result)}`);
ok('проигрыватель видит, что открыт внутри приложения', result.ua === true);
ok('бридж выдал пропуск на камеру, адрес видео — этот компьютер', result.sessionStatus === 200 && result.local === true && String(result.whep).startsWith(`http://127.0.0.1:${P.webrtc}/`));
ok('на чужую камеру пропуск не выдаётся', result.unknownCam === 404);
ok('без пропуска видео не отдаётся', result.noToken === 401, String(result.noToken));
ok('поддельный пропуск не принимается', result.fakeToken === 401, String(result.fakeToken));
ok('пропуск на одну камеру не открывает другую', result.otherCam === 401, String(result.otherCam));
ok('с пропуском соединение установлено', result.whepStatus === 201 && result.state === 'connected', `${result.whepStatus} ${result.state} ${result.error || ''}`);
ok('кадры реально декодируются в окне приложения', result.frames >= 30 && result.size === '640x360', `${result.frames} кадров, ${result.size}`);
ok('первый кадр появляется быстрее 5 секунд', result.firstFrameMs > 0 && result.firstFrameMs < 5000, `${result.firstFrameMs} мс`);

console.log('\nПауза доступа');
{
  access = { allowed: false };
  const r = await fetch(`http://127.0.0.1:${P.bridge}/live/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: DASH }, body: JSON.stringify({ camera_id: CAM }) });
  ok('клиент на паузе пропуск на видео не получает', r.status === 403);
  const evil = await fetch(`http://127.0.0.1:${P.bridge}/live/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ camera_id: CAM }) });
  ok('чужой сайт пропуск на видео не получает', evil.status === 403);
}

dash.close(); cleanup();
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);
