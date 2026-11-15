// Сквозная проверка рамок и подсчёта: видео с идущими людьми → камера → локальный видеосервер →
// бридж (детектор, трекер, линия подсчёта) → сообщение с рамками для панели.
// Запуск: SZ_MEDIAMTX=/путь/к/mediamtx node e2e-tracks.mjs
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const media = require('../media.js');
const MTX = process.env.SZ_MEDIAMTX;
if (!MTX) { console.log('нужен SZ_MEDIAMTX'); process.exit(2); }
const B = '../../edge-server/bridge';
const P = { cam: 29554, bridge: 28099, api: 29997, rtsp: 28554, webrtc: 28889, ice: 28189 };
const { startApi } = await import(`${B}/api.js`);
const { loadKey, MediaSync, internalReadUrl } = await import(`${B}/media.js`);
const { FrameStream } = await import(`${B}/stream.js`);
const { createYolox } = await import(`${B}/yolox.js`);
const { CameraTracker } = await import(`${B}/tracker.js`);
const { LineCounter } = await import(`${B}/counter.js`);
const { tracksPayload } = await import(`${B}/live.js`);

let passed = 0, failed = 0;
const ok = (n, c, e = '') => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} ${e}`); } };
const info = (t) => console.log(`  ·    ${t}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const procs = [];
const run = (bin, args) => { const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(p); p.log = ''; const add = d => { p.log = (p.log + d).slice(-4000); }; p.stdout.on('data', add); p.stderr.on('data', add); return p; };
const cleanup = () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } };
process.on('exit', cleanup);

const dir = mkdtempSync(join(tmpdir(), 'sz-e2e-tr-'));
const CAM = '11111111-2222-4333-8444-666666666666';
const secrets = media.ensureMediaSecrets(dir);
const key = loadKey(secrets.privateKeyPem);
const photo = new URL(`${B}/test-assets/two_people.jpg`, import.meta.url).pathname;

writeFileSync(join(dir, 'cam.yml'), `logLevel: warn\napi: false\nrtsp: true\nrtspAddress: 127.0.0.1:${P.cam}\nrtmp: false\nhls: false\nwebrtc: false\nsrt: false\nmoq: false\npaths:\n  all_others:\n`);
run(MTX, [join(dir, 'cam.yml')]);
await sleep(1200);
// двое людей идут слева направо через весь кадр за 16 секунд
const cam = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-loop', '1', '-i', photo, '-f', 'lavfi', '-i', 'color=c=0x8a8f93:s=960x540:r=10',
  '-filter_complex', "[0:v]scale=-1:430[p];[1:v][p]overlay=x='-1150+t*110':y=110", '-t', '30', '-r', '10',
  '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-tune', 'zerolatency', '-g', '10', '-bf', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${P.cam}/cam`]);
startApi({ version: 'e2e', log: () => {}, media: { key, bridgeSecret: secrets.secret }, getStatus: () => ({}) }, { port: P.bridge, host: '127.0.0.1' });
writeFileSync(join(dir, 'mediamtx.yml'), media.mediamtxConfig({ bridgeApiPort: P.bridge, origins: [], ports: P }));
run(MTX, [join(dir, 'mediamtx.yml')]);
await sleep(2500);
await new MediaSync({ apiBase: `http://127.0.0.1:${P.api}` }).sync([{ id: CAM, ip_address: '10.0.0.6' }], () => `rtsp://127.0.0.1:${P.cam}/cam`);

const yx = createYolox('yolox_s.onnx', 640);
await yx.init();
const tracker = new CameraTracker();
const counter = new LineCounter({ lines: [{ id: 'door', x1: 0.5, y1: 0, x2: 0.5, y2: 1, inside: 'right' }] });
const seen = new Map();
const events = [];
const payloads = [];
let frames = 0, withPeople = 0, maxPeople = 0;
const timeline = [];
const stream = new FrameStream({
  url: internalReadUrl(`rtsp://127.0.0.1:${P.rtsp}`, CAM, secrets.secret), fps: 5, name: 'e2e',
  onFrame: async (buf, t) => {
    frames++;
    const people = (await yx.detect(buf)).filter(d => d.cls === 'person');
    timeline.push(people.map(d => `${((d.x1 + d.x2) / 2).toFixed(2)}@${Math.round(d.conf * 100)}`).join(' ') || '-');
    if (people.length) withPeople++;
    maxPeople = Math.max(maxPeople, people.length);
    const tracks = tracker.update(people, t);
    for (const tr of tracks) {
      if (tr.lastSeen !== t || (tr.group && tr.group !== 'person')) continue;
      const cx = (tr.box.x1 + tr.box.x2) / 2;
      const s = seen.get(tr.id) || { first: cx, last: cx, n: 0 };
      s.last = cx; s.n++; seen.set(tr.id, s);
    }
    for (const ev of counter.observe(tracks, t)) events.push(ev);
    const pl = tracksPayload(CAM, tracks, t);
    if (pl.tracks.length) payloads.push(pl);
  },
});
console.log('\nВидео с людьми через локальный видеосервер');
stream.start();
for (let i = 0; i < 62 && cam.exitCode === null; i++) await sleep(500);
stream.stop();
await sleep(300);

const long = [...seen.entries()].filter(([, s]) => s.n >= 8);
info(`кадров ${frames}, с людьми ${withPeople}, одновременно до ${maxPeople}; номера: ${[...seen.entries()].map(([id, s]) => `#${id}×${s.n} (${s.first.toFixed(2)}→${s.last.toFixed(2)})`).join(', ')}`);
info(`по кадрам (центр@уверенность): ${timeline.filter((_, i) => i % 3 === 0).join(' | ')}`);
info(`проходы через линию: ${events.map(e => `#${e.trackId} ${e.direction}`).join(', ') || 'нет'}`);
ok('бридж получает непрерывный поток кадров', frames >= 40, String(frames));
ok('на кадрах находятся оба человека', maxPeople === 2 && withPeople >= 20, `${maxPeople}, ${withPeople}`);
ok('за каждым человеком держится один номер на всём пути', long.length === 2 && seen.size <= 3, `долгих номеров ${long.length}, всего ${seen.size}`);
ok('рамки двигаются вместе с людьми слева направо', long.every(([, s]) => s.last - s.first > 0.3), JSON.stringify(long.map(([, s]) => [s.first, s.last])));
ok('линия на входе посчитала ровно двоих, оба — вход', events.length === 2 && events.every(e => e.direction === 'in') && new Set(events.map(e => e.trackId)).size === 2, JSON.stringify(events));
const inside = payloads.filter(p => p.tracks.length === 2 && p.tracks.every(t => t.b[0] > 0.03 && t.b[2] < 0.97));
const sample = inside[Math.floor(inside.length / 2)];
info(`сообщение для панели: ${JSON.stringify(sample)}`);
ok('в панель уходят номер и рамка в долях кадра', sample && sample.camera_id === CAM && sample.tracks.every(t => Number.isInteger(t.id) && t.b.length === 4 && t.b.every(v => v >= 0 && v <= 1) && t.b[2] > t.b[0] && t.b[3] > t.b[1]));
ok('есть кадры, где оба человека целиком в кадре', inside.length >= 3, String(inside.length));
ok('рамка совпадает с человеком: ширина и высота правдоподобны', sample && sample.tracks.every(t => (t.b[2] - t.b[0]) > 0.2 && (t.b[2] - t.b[0]) < 0.5 && (t.b[3] - t.b[1]) > 0.6));
ok('рамки двух людей не сливаются в одну', sample && Math.abs((sample.tracks[0].b[0] + sample.tracks[0].b[2]) - (sample.tracks[1].b[0] + sample.tracks[1].b[2])) / 2 > 0.25);

cleanup();
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);
