// Тесты безопасности бриджа: атака через браузер, утечка паролей, чтение файлов через ffmpeg.
import http from 'http';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startApi, guard } from './api.js';
import { grabSnapshot, redactSecrets, isCameraUrl, CAMERA_PROTOCOLS } from './safety.js';

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); } };
const info = (t) => console.log(`  ·    ${t}`);
const PORT = 18299;
const probed = [];
startApi({
  version: 'test', log: () => {},
  grabSnapshot: async (url) => { probed.push(url); throw new Error(`exit 1: ${url}: Connection refused`); },
  detect: async () => [], buildRtspUrl: (b) => `rtsp://${b.user}:${b.pass}@${b.ip}:554/`, getStatus: () => ({}),
}, { port: PORT, host: '127.0.0.1' });
await new Promise(r => setTimeout(r, 300));

const send = (path, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
    let data = ''; res.on('data', d => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, body: data, acao: res.headers['access-control-allow-origin'] }));
  });
  req.on('error', e => resolve({ status: 0, body: e.message }));
  if (body) req.write(body); req.end();
});
const JSONH = { 'content-type': 'application/json' };

console.log('\nАтака через браузер на локальный API');
{
  const evil = await send('/probe', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: JSON.stringify({ rtsp: 'rtsp://10.0.0.5/' }) });
  ok('чужой сайт: POST без предварительной проверки браузера отклонён', evil.status === 403, String(evil.status));
  const evil2 = await send('/discover', { method: 'POST', headers: { origin: 'https://evil.example', ...JSONH }, body: '{}' });
  ok('чужой сайт не может запустить поиск камер', evil2.status === 403);
  const rebind = await send('/health', { headers: { host: `attacker.example:${PORT}` } });
  ok('подмена DNS: запрос с чужим Host отклонён', rebind.status === 403);
  const plain = await send('/probe', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"ip":"10.0.0.5"}' });
  ok('POST без JSON отклонён', plain.status === 415);
  const reload = await send('/settings/reload', { method: 'POST', headers: { origin: 'https://safezone-gamma.vercel.app' } });
  ok('панель перезагружает настройки без JSON, как и раньше', reload.status !== 415 && reload.status !== 403, String(reload.status));
  const evilReload = await send('/settings/reload', { method: 'POST', headers: { origin: 'https://evil.example' } });
  ok('чужой сайт не может перезагрузить настройки', evilReload.status === 403);
  const panel = await send('/health', { headers: { origin: 'https://safezone-gamma.vercel.app' } });
  ok('наша панель проходит и получает разрешение браузера', panel.status === 200 && panel.acao === 'https://safezone-gamma.vercel.app');
  const old = await send('/health', { headers: { origin: 'https://safezone.vercel.app' } });
  ok('чужой домен из старых настроек больше не допущен', old.status === 403);
  const local = await send('/health');
  ok('программа на этом компьютере без Origin работает', local.status === 200);
  ok('проверка Host: localhost и ::1 допустимы', !guard({ headers: { host: `localhost:${PORT}` }, method: 'GET', url: '/' }, PORT) && !guard({ headers: { host: `[::1]:${PORT}` }, method: 'GET', url: '/' }, PORT));
}

console.log('\nЧтение файлов компьютера через адрес камеры');
{
  probed.length = 0;
  for (const bad of ['file:///etc/passwd', 'http://169.254.169.254/latest/meta-data', 'concat:/etc/passwd', 'subfile,,start,0,end,0,,:/etc/shadow']) {
    const r = await send('/probe', { method: 'POST', headers: JSONH, body: JSON.stringify({ rtsp: bad }) });
    ok(`адрес «${bad.slice(0, 26)}» отклонён`, r.status === 400);
  }
  ok('ни один опасный адрес не дошёл до ffmpeg', probed.length === 0, probed.join(' | '));
  ok('проверка адреса: rtsp и rtsps проходят', isCameraUrl('rtsp://10.0.0.5:554/stream') && isCameraUrl('rtsps://cam/x') && !isCameraUrl(' file:///x') && !isCameraUrl(null));
  const real = spawnSync('ffmpeg', ['-hide_banner', '-protocol_whitelist', CAMERA_PROTOCOLS, '-i', 'file:/etc/hostname', '-f', 'null', '-'], { encoding: 'utf8' });
  info(`настоящий ffmpeg с белым списком на file: → ${(real.stderr.match(/[^\n]*whitelist[^\n]*/) || ['?'])[0].trim().slice(0, 90)}`);
  ok('даже если адрес пройдёт проверку, ffmpeg откажется читать файл', real.status !== 0 && /whitelist/i.test(real.stderr));
  const net = spawnSync('ffmpeg', ['-hide_banner', '-protocol_whitelist', CAMERA_PROTOCOLS, '-rtsp_transport', 'tcp', '-i', 'rtsp://127.0.0.1:1/x', '-f', 'null', '-'], { encoding: 'utf8', timeout: 15000 });
  ok('белый список не мешает подключаться к камерам по RTSP', !/whitelist/i.test(net.stderr), net.stderr.slice(-160));
}

{
  const { extractBurst } = await import('./burst.js').catch(() => ({}));
  const fn = extractBurst || Object.values(await import('./burst.js')).find(f => typeof f === 'function');
  let msg = '';
  try { await fn('file:///etc/passwd', 4, 4); } catch (e) { msg = e.message; }
  ok('серия кадров не открывает file:// адрес', /rtsp:\/\//.test(msg), msg);
  msg = '';
  try { await fn('concat:/etc/passwd', 4, 4); } catch (e) { msg = e.message; }
  ok('серия кадров не открывает concat: адрес', /rtsp:\/\//.test(msg), msg);
}

console.log('\nПароли камер в журналах и ответах');
{
  ok('пароль в адресе скрывается', redactSecrets('rtsp://admin:Secr3t!@10.0.0.5:554/x: refused') === 'rtsp://***@10.0.0.5:554/x: refused');
  ok('токен в параметрах скрывается', !redactSecrets('https://x/live?jwt=abc.def&cam=1').includes('abc.def'));
  ok('текст без секретов не меняется', redactSecrets('поток прервался: Connection refused') === 'поток прервался: Connection refused');
  const r = await send('/probe', { method: 'POST', headers: JSONH, body: JSON.stringify({ ip: '10.0.0.5', user: 'admin', pass: 'Secr3t!' }) });
  ok('ответ /probe не содержит пароль камеры', r.status === 200 && !r.body.includes('Secr3t') && r.body.includes('***@'), r.body.slice(0, 160));
  const dir = mkdtempSync(join(tmpdir(), 'sz-sec-'));
  const fake = join(dir, 'ffmpeg-fake.sh');
  writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do case "$a" in rtsp*) echo "[rtsp @ 0x1] $a: Connection refused" >&2;; esac; done\nexit 1\n'); chmodSync(fake, 0o755);
  let msg = '';
  try { await grabSnapshot('rtsp://admin:Secr3t!@10.0.0.5:554/cam/realmonitor?channel=1', 'cam1', { bin: fake }); } catch (e) { msg = e.message; }
  info(`ffmpeg напечатал адрес с паролем, бридж записал: ${msg.slice(0, 90)}`);
  ok('ошибка снимка не содержит пароль камеры', msg && !msg.includes('Secr3t') && msg.includes('***@'));
  let bad = '';
  try { await grabSnapshot('file:///etc/passwd', 'cam1', { bin: fake }); } catch (e) { bad = e.message; }
  ok('снимок по не-RTSP адресу даже не запускает ffmpeg', /rtsp:\/\//.test(bad));
}

console.log('\nЛица только по решению клиента');
{
  const { SCHEMA } = await import('./settings.js');
  const { planAnalyzers } = await import('./live.js');
  ok('выключатель чёрного списка есть и по умолчанию выключен', SCHEMA.FACES_ENABLED && SCHEMA.FACES_ENABLED.def === false && SCHEMA.FACES_ENABLED.type === 'bool');
  const cams = [{ id: 'c1', name: 'Вход' }];
  const features = { blacklist: true };
  const plan = (faceCameras) => [...planAnalyzers({ cams, features, faceCameras, blacklistSize: 3 }).values()];
  const on = plan(new Set(['c1'])), off = plan(new Set());
  ok('при включённом выключателе камера входа ищет лица', on.some(p => p.faces), JSON.stringify(on));
  ok('при выключенном — ни одна камера не обрабатывает лица', !off.some(p => p.faces), JSON.stringify(off));
  const src = (await import('fs')).readFileSync('./index.js', 'utf8');
  ok('выключатель подключён к анализу, загрузке списка и добавлению фото', src.includes('faceCameras: RT.FACES_ENABLED ? faceCameras : new Set()') && src.includes('matcher.size && RT.FACES_ENABLED') && src.includes('|| !RT.FACES_ENABLED) return;'));
}

console.log('\nОблачные вызовы');
{
  const src = (await import('fs')).readFileSync('./index.js', 'utf8');
  const cloudCalls = [...src.matchAll(/\n  if \(([^\n]*?)(OPENROUTER_API_KEY|GEMINI_KEYS\.length > 0|GROQ_API_KEY|OPENAI_API_KEY)\) \{/g)].map(m => m[1] + m[2]);
  ok('каждая облачная модель вызывается, только если ответа ещё нет', cloudCalls.length >= 4 && cloudCalls.every(c => c.startsWith('!result &&')), JSON.stringify(cloudCalls));
  ok('платформа стоит раньше запасных ключей', src.indexOf('platformVision({ url: PLATFORM_VISION_URL') < src.indexOf('openrouter.ai/api/v1/chat/completions') && src.indexOf('platformVision({ url: PLATFORM_VISION_URL') > 0);
  ok('отказ платформы по доступу не обходится запасными ключами', /e\.kind === 'access' \|\| e\.kind === 'denied' \|\| e\.kind === 'budget'\) \{\s*return/.test(src));
}

console.log('\nПропуск на живое видео с этого компьютера');
{
  const { localLiveSession, loadKey, verifyJwt, pathFor } = await import('./media.js');
  const { generateKeyPairSync } = await import('crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const priv = loadKey(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const pubOnly = loadKey(publicKey.export({ type: 'spki', format: 'pem' }));
  const CAM = '11111111-2222-4333-8444-555555555555';
  const media = { enabled: true, whep: 'http://127.0.0.1:8889/', key: priv };
  const good = localLiveSession({ media, cameras: [{ id: CAM }], cameraId: CAM, now: 1000 });
  ok('пропуск выдаётся на камеру бриджа', good.status === 200 && good.body.whepUrl === `http://127.0.0.1:8889/${pathFor(CAM)}/whep` && good.body.expiresAt === 121000);
  const claims = verifyJwt(priv, good.body.token);
  ok('пропуск подписан и действует только на эту камеру', claims.mediamtx_permissions.length === 1 && claims.mediamtx_permissions[0].path === pathFor(CAM) && claims.mediamtx_permissions[0].action === 'read');
  ok('пропуск живёт две минуты', claims.exp - claims.iat === 120);
  ok('чужая камера → отказ', localLiveSession({ media, cameras: [{ id: CAM }], cameraId: '99999999-2222-4333-8444-555555555555' }).status === 404);
  ok('битый номер камеры → отказ', localLiveSession({ media, cameras: [{ id: CAM }], cameraId: "x'; drop" }).status === 400 && localLiveSession({ media, cameras: [{ id: CAM }], cameraId: null }).status === 400);
  ok('клиент на паузе → отказ', localLiveSession({ media, cameras: [{ id: CAM }], cameraId: CAM, access: { allowed: false } }).status === 403);
  ok('без своего ключа подписи бридж пропуска не выдаёт', localLiveSession({ media: { ...media, key: pubOnly }, cameras: [{ id: CAM }], cameraId: CAM }).status === 503);
  ok('локальное видео выключено → отказ, панель пойдёт через облако', localLiveSession({ media: { enabled: false }, cameras: [{ id: CAM }], cameraId: CAM }).status === 503 && localLiveSession({ media: { ...media, whep: '' }, cameras: [{ id: CAM }], cameraId: CAM }).status === 503);
}

console.log(`\n  Пройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);
