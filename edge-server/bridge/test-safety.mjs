// Тесты защиты бриджа: каждая авария воспроизводится по-настоящему.
process.env.TZ = 'Europe/Berlin';

import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';
import sharp from 'sharp';
import { singleFlight, localClock, withinHours, localTime, fetchWithTimeout, tmpSnapshotPath, frameDiff } from './safety.js';

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const info = (t) => console.log(`  ·    ${t}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'sz-safety-'));
const script = (name, body) => { const p = join(dir, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };

console.log('\nОдин проход за раз');
{
  let runs = 0; const skips = [];
  const slow = singleFlight(async () => { runs++; await sleep(120); }, { onSkip: n => skips.push(n) });
  const res = await Promise.all([slow(), slow(), slow(), slow(), slow()]);
  ok('пять одновременных запусков → выполнен один', runs === 1, `выполнено ${runs}`);
  ok('остальные четыре пропущены и посчитаны', skips.join(',') === '1,2,3,4' && res.filter(Boolean).length === 1, skips.join(','));
  await slow();
  ok('после завершения следующий запуск проходит', runs === 2);
  let caught = null, after = 0;
  const bad = singleFlight(async () => { after++; if (after === 1) throw new Error('база недоступна'); }, { onError: e => { caught = e.message; } });
  await bad(); await bad();
  ok('ошибка прохода не ломает цикл и не блокирует следующий', caught === 'база недоступна' && after === 2 && !bad.isBusy());

  const measure = async (wrap) => {
    let now = 0, max = 0;
    const body = async () => { now++; max = Math.max(max, now); await sleep(260); now--; };
    const fn = wrap ? singleFlight(body) : body;
    const t = setInterval(() => { fn(); }, 50);
    await sleep(700); clearInterval(t); await sleep(320);
    return max;
  };
  const before = await measure(false), afterMax = await measure(true);
  info(`таймер 50 мс, проход 260 мс: без защиты одновременно шло ${before} проходов, с защитой ${afterMax}`);
  ok('проходы цикла не накладываются', afterMax === 1 && before > 1, `было ${before}, стало ${afterMax}`);
}

console.log('\nЧасы объекта, а не сервера');
{
  const d = new Date('2026-11-10T20:30:00Z');
  const c = localClock('Asia/Almaty', d);
  info(`сервер в Берлине показывает ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}, объект в Астане ${c.hour}:${String(c.minute).padStart(2, '0')}`);
  ok('час объекта считается по его поясу', c.hour === 1 && c.minute === 30 && d.getHours() === 21);
  const oldLogic = (() => { const cur = d.getHours() * 60 + d.getMinutes(); return cur >= 22 * 60 || cur < 7 * 60; })();
  ok('ночь 22:00–07:00: объект уже в нерабочих часах', withinHours('22:00', '07:00', 'Asia/Almaty', d) === true);
  ok('старая логика по часам сервера ошибалась', oldLogic === false);
  ok('дневной интервал 09:00–18:00', withinHours('09:00', '18:00', 'Asia/Almaty', new Date('2026-11-10T07:00:00Z')) === true && withinHours('09:00', '18:00', 'Asia/Almaty', d) === false);
  ok('граница интервала: начало входит, конец нет', withinHours('22:00', '07:00', 'Asia/Almaty', new Date('2026-11-10T17:00:00Z')) === true && withinHours('22:00', '07:00', 'Asia/Almaty', new Date('2026-11-10T02:00:00Z')) === false);
  ok('пустой и битый интервал не включает режим', withinHours('08:00', '08:00') === false && withinHours('abc', null) === false);
  ok('время в тревоге показывается по объекту', localTime('Asia/Almaty', d).startsWith('01:30'), localTime('Asia/Almaty', d));
}

console.log('\nВременные файлы');
{
  const a = tmpSnapshotPath('cam-1'), b = tmpSnapshotPath('cam-1'), evil = tmpSnapshotPath('../../etc/passwd');
  ok('путь лежит в системной временной папке', a.startsWith(tmpdir()) && a.endsWith('.jpg'));
  ok('два снимка подряд не затирают друг друга', a !== b);
  ok('идентификатор камеры не может вывести путь наружу', evil.startsWith(tmpdir()) && !evil.includes('..'));
}

console.log('\nЗапросы без ответа');
{
  const silent = http.createServer(() => {}).listen(0);
  const fast = http.createServer((q, r) => r.end('ok')).listen(0);
  const t0 = Date.now(); let err = null;
  try { await fetchWithTimeout(`http://127.0.0.1:${silent.address().port}/`, {}, 300); } catch (e) { err = e; }
  const took = Date.now() - t0;
  info(`сервер молчит: запрос оборван через ${took} мс`);
  ok('молчащий сервер не подвешивает бридж', !!err && took < 1500, `${took} мс`);
  const r = await fetchWithTimeout(`http://127.0.0.1:${fast.address().port}/`, {}, 2000);
  ok('обычный ответ проходит как раньше', r.ok && (await r.text()) === 'ok');
  silent.closeAllConnections?.(); silent.close(); fast.close();
}

console.log('\nСравнение кадров через ffmpeg');
{
  const gray = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer();
  const other = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 120, b: 120 } } })
    .composite([{ input: { create: { width: 160, height: 240, channels: 3, background: { r: 250, g: 20, b: 20 } } }, left: 0, top: 0 }]).jpeg().toBuffer();
  const same = await frameDiff(gray, gray), diff = await frameDiff(gray, other);
  info(`одинаковые кадры: ${same.toFixed(2)}%, разные: ${diff.toFixed(2)}%`);
  ok('настоящий ffmpeg: одинаковые кадры ≈ 0', same < 1, String(same));
  ok('настоящий ffmpeg: разные кадры выше порога движения 0,4% с запасом', diff > 2 && diff > same + 2, String(diff));
  ok('ffmpeg не установлен → 100, бридж жив', (await frameDiff(gray, other, { bin: 'ffmpeg-которого-нет' })) === 100);
  const hang = script('hang.sh', '#!/bin/sh\nsleep 30\n');
  const t0 = Date.now(); const h = await frameDiff(gray, other, { bin: hang, timeoutMs: 400 }); const took = Date.now() - t0;
  info(`ffmpeg завис: остановлен через ${took} мс`);
  ok('зависший ffmpeg останавливается по таймауту', h === 100 && took < 1500, `${took} мс`);
  const dead = script('dead.sh', '#!/bin/sh\nexit 0\n');
  const big = Buffer.alloc(4 * 1024 * 1024, 7);
  ok('ffmpeg закрылся раньше времени → 100, бридж жив', (await frameDiff(big, big, { bin: dead })) === 100);

  const oldCode = `
import { spawn } from 'child_process';
function frameDiff(buf1, buf2) { return new Promise((resolve) => { try {
  const ff = spawn(process.argv[2], ['-i','pipe:3','-i','pipe:4'], { stdio: ['ignore','ignore','pipe','pipe','pipe'] });
  let stderr = ''; ff.stderr.on('data', d => { stderr += d.toString(); });
  ff.stdio[3].write(buf1); ff.stdio[3].end(); ff.stdio[4].write(buf2); ff.stdio[4].end();
  ff.on('close', () => resolve(100)); ff.on('error', () => resolve(100)); } catch { resolve(100); } }); }
const big = Buffer.alloc(4 * 1024 * 1024, 7);
await frameDiff(big, big); await new Promise(r => setTimeout(r, 300)); console.log('alive');`;
  const oldFile = join(dir, 'old.mjs'); writeFileSync(oldFile, oldCode);
  const run = spawnSync(process.execPath, [oldFile, dead], { encoding: 'utf8', timeout: 15000 });
  const crashed = run.status !== 0 || !String(run.stdout).includes('alive');
  info(`контроль: старый код в той же ситуации ${crashed ? 'ПАДАЛ: ' + (String(run.stderr).match(/Error: [^\n]+/) || [''])[0] : 'не упал в этой среде'}`);
}

console.log('\nНеобработанные ошибки');
{
  const guarded = join(dir, 'guarded.mjs');
  writeFileSync(guarded, `import { installProcessGuards } from ${JSON.stringify(join(process.cwd(), 'safety.js'))};
installProcessGuards(() => {});
Promise.reject(new Error('фоновая задача упала'));
setTimeout(() => { throw new Error('ошибка в таймере'); }, 50);
setTimeout(() => { console.log('alive'); }, 300);`);
  const plain = join(dir, 'plain.mjs');
  writeFileSync(plain, `Promise.reject(new Error('фоновая задача упала'));\nsetTimeout(() => { console.log('alive'); }, 300);`);
  const g = spawnSync(process.execPath, [guarded], { encoding: 'utf8', timeout: 15000 });
  const p = spawnSync(process.execPath, [plain], { encoding: 'utf8', timeout: 15000 });
  info(`контроль: без защиты процесс ${p.status !== 0 ? 'завершился с кодом ' + p.status : 'выжил'}`);
  ok('с защитой бридж переживает ошибку в фоне и в таймере', g.status === 0 && String(g.stdout).includes('alive'), `код ${g.status}`);
  ok('без защиты та же ошибка завершала процесс', p.status !== 0 && !String(p.stdout).includes('alive'));
}

console.log(`\n  Пройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);
