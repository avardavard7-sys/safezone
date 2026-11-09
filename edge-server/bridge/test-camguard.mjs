// Тесты контроля камеры на нарисованных сценах: сдвиг, перевес, закрытый объектив, свет и люди.
import sharp from 'sharp';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { signature, verdict, CameraGuard } from './camguard.js';

let passed = 0, failed = 0;
const ok = (n, c, e = '') => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} ${e}`); } };
const info = (t) => console.log(`  ·    ${t}`);
const SW = 960, SH = 540;
const shop = `<svg xmlns="http://www.w3.org/2000/svg" width="${SW * 2}" height="${SH * 2}"><rect width="100%" height="100%" fill="#8f9396"/>
<rect x="0" y="560" width="1920" height="520" fill="#b9b3a6"/>
<rect x="260" y="250" width="300" height="420" fill="#5b4a3c"/><rect x="280" y="290" width="260" height="14" fill="#d8d0c0"/><rect x="280" y="380" width="260" height="14" fill="#d8d0c0"/><rect x="280" y="470" width="260" height="14" fill="#d8d0c0"/>
<rect x="760" y="230" width="340" height="460" fill="#3f5d73"/><rect x="780" y="300" width="300" height="16" fill="#e6e2d6"/><rect x="780" y="420" width="300" height="16" fill="#e6e2d6"/><rect x="780" y="540" width="300" height="16" fill="#e6e2d6"/>
<rect x="1280" y="200" width="220" height="500" fill="#2e2e33"/><rect x="1310" y="240" width="160" height="300" fill="#a9c7d9"/>
<polygon points="0,1080 600,700 1320,700 1920,1080" fill="#c9c2b3"/><rect x="1600" y="330" width="240" height="330" fill="#7a3b2e"/></svg>`;
const other = `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}"><rect width="100%" height="100%" fill="#707a70"/>
<circle cx="240" cy="270" r="170" fill="#d9d2c0"/><rect x="520" y="60" width="60" height="420" fill="#2b2b2b"/><polygon points="640,480 800,90 940,480" fill="#445a8a"/><rect x="0" y="470" width="960" height="70" fill="#3a3a3a"/></svg>`;
const wide = await sharp(Buffer.from(shop)).png().toBuffer();
const view = (dx = 0, dy = 0) => sharp(wide).extract({ left: 480 + dx, top: 270 + dy, width: SW, height: SH });
const jpg = (img) => img.jpeg({ quality: 85 }).toBuffer();
const base = await jpg(view());
const ref = await signature(base);
const person = (x) => ({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="110" height="300"><ellipse cx="55" cy="45" rx="34" ry="42" fill="#2a2420"/><rect x="12" y="85" width="86" height="210" rx="30" fill="#31486b"/></svg>`), left: x, top: 200 });
const check = async (buf) => verdict(ref, await signature(buf));

console.log('\nКамера на месте');
{
  ok('тот же вид → всё в порядке', (await check(base)).state === 'ok');
  ok('стало темнее → не тревога', (await check(await jpg(view().modulate({ brightness: 0.55 })))).state === 'ok');
  ok('стало светлее → не тревога', (await check(await jpg(view().modulate({ brightness: 1.5 })))).state === 'ok');
  const night = await check(await jpg(view().grayscale().modulate({ brightness: 0.7 }).linear(0.8, 10)));
  ok('ночной чёрно-белый режим камеры → не тревога', night.state === 'ok', JSON.stringify(night));
  const crowd = await check(await jpg(view().composite([person(120), person(430), person(700)])));
  ok('трое людей в кадре → не тревога', crowd.state === 'ok', JSON.stringify(crowd));
  ok('сильное сжатие видео → не тревога', (await check(await view().jpeg({ quality: 20 }).toBuffer())).state === 'ok');
  ok('дрожание на пару пикселей → не тревога', (await check(await jpg(view(6, 4)))).state === 'ok');
}

console.log('\nКамеру тронули');
{
  const right = await check(await jpg(view(150, 0)));
  info(`сдвиг вправо на 16% кадра: ${JSON.stringify(right)}`);
  ok('сдвиг по горизонтали распознаётся как сдвиг', right.state === 'shifted' && Math.abs(right.dx) >= 10 && Math.abs(right.dx) <= 22, JSON.stringify(right));
  const down = await check(await jpg(view(0, 80)));
  ok('сдвиг по вертикали распознаётся как сдвиг', down.state === 'shifted' && Math.abs(down.dy) >= 8, JSON.stringify(down));
  const diag = await check(await jpg(view(-130, -60)));
  ok('сдвиг по диагонали распознаётся', diag.state === 'shifted', JSON.stringify(diag));
  const moved = await check(await sharp(Buffer.from(other)).jpeg().toBuffer());
  ok('камеру перевесили на другую сцену', moved.state === 'changed', JSON.stringify(moved));
  const black = await check(await sharp({ create: { width: SW, height: SH, channels: 3, background: { r: 6, g: 6, b: 6 } } }).jpeg().toBuffer());
  ok('объектив закрыт → камера не видит сцену', black.state === 'blocked');
  const hand = await check(await sharp({ create: { width: SW, height: SH, channels: 3, background: { r: 150, g: 110, b: 95 } } }).blur(20).jpeg().toBuffer());
  ok('объектив закрыт рукой или тканью', hand.state === 'blocked', JSON.stringify(hand));
}

console.log('\nТревога без ложных срабатываний');
{
  const shifted = await signature(await jpg(view(150, 0)));
  const good = await signature(base);
  const g = new CameraGuard({ confirm: 3, minGapMs: 30_000, repeatMs: 6 * 3600_000 });
  let t = 1_000_000;
  ok('первый кадр камеры становится образцом, тревоги нет', g.check('c1', good, t) === null && g.hasReference('c1'));
  ok('человек встал перед камерой на одну проверку → тишина', g.check('c1', shifted, t += 31_000) === null && g.check('c1', good, t += 31_000) === null);
  const a = g.check('c1', shifted, t += 31_000), b = g.check('c1', shifted, t += 31_000), c = g.check('c1', shifted, t += 31_000);
  ok('три проверки подряд показали сдвиг → тревога', a === null && b === null && c && c.type === 'camera_moved' && /сдвинули/.test(c.description), JSON.stringify(c));
  ok('повторно о той же камере не шлёт 6 часов', g.check('c1', shifted, t += 31_000) === null && g.check('c1', shifted, t += 3600_000) === null);
  ok('через 6 часов напоминает', g.check('c1', shifted, t += 6 * 3600_000)?.type === 'camera_moved');
  ok('проверки чаще раза в 30 секунд не считаются', (() => { const q = new CameraGuard({ confirm: 3 }); q.check('x', good, 0); let hits = 0; for (let i = 1; i <= 20; i++) if (q.check('x', shifted, 31_000 + i * 100)) hits++; return hits === 0; })());
  const g2 = new CameraGuard({ confirm: 3 }); g2.check('c2', good, 0);
  const dark = await signature(await sharp({ create: { width: SW, height: SH, channels: 3, background: { r: 5, g: 5, b: 5 } } }).jpeg().toBuffer());
  g2.check('c2', dark, 31_000); g2.check('c2', dark, 62_000);
  ok('закрытая камера даёт отдельный тип события', g2.check('c2', dark, 93_000)?.type === 'camera_blocked');
  const g3 = new CameraGuard({ confirm: 3 });
  ok('тёмный первый кадр не становится образцом', g3.check('c3', dark, 0) === null && !g3.hasReference('c3'));
  g.setReference('c1', shifted);
  ok('новый образец после перерисовки зон снимает тревогу', g.check('c1', shifted, t += 31_000) === null);
}

console.log('\nКамеру переставили намеренно');
{
  const good = await signature(base), shifted = await signature(await jpg(view(150, 0)));
  const dark = await signature(await sharp({ create: { width: SW, height: SH, channels: 3, background: { r: 5, g: 5, b: 5 } } }).jpeg().toBuffer());
  const accepted = [];
  const g = new CameraGuard({ confirm: 3, onAccept: id => accepted.push(id) });
  let t = 0; g.check('c9', good, t);
  let alerts = 0;
  for (let i = 0; i < 3; i++) if (g.check('c9', shifted, t += 31_000)) alerts++;
  for (let h = 1; h <= 23; h++) if (g.check('c9', shifted, t += 3600_000)) alerts++;
  ok('в первые сутки приходит тревога и напоминания', alerts >= 2 && accepted.length === 0, `тревог ${alerts}`);
  const after = g.check('c9', shifted, t += 2 * 3600_000);
  ok('через сутки новый вид принят за образец, сообщений больше нет', after === null && accepted.join() === 'c9' && g.check('c9', shifted, t += 31_000) === null);
  ok('после принятия старый вид считается сдвигом', (() => { let hit = null; for (let i = 0; i < 3; i++) hit = g.check('c9', good, t += 31_000) || hit; return hit && hit.type === 'camera_moved'; })());
  const b = new CameraGuard({ confirm: 3, onAccept: id => accepted.push('blocked:' + id) });
  let tb = 0; b.check('c10', good, tb);
  for (let i = 0; i < 3; i++) b.check('c10', dark, tb += 31_000);
  for (let h = 1; h <= 30; h++) b.check('c10', dark, tb += 3600_000);
  ok('закрытый объектив за образец не принимается никогда', !accepted.includes('blocked:c10') && b.check('c10', good, tb += 31_000) === null);
}

console.log('\nПерезагрузка компьютера');
{
  const file = join(mkdtempSync(join(tmpdir(), 'sz-guard-')), 'camguard.json');
  const g = new CameraGuard({ file }); g.check('cam-7', await signature(base), 0);
  const g2 = new CameraGuard({ file, confirm: 1 });
  ok('образец камеры переживает перезапуск', g2.hasReference('cam-7'));
  ok('после перезапуска тот же вид → в порядке, сдвиг → тревога', g2.check('cam-7', await signature(base), 31_000) === null && g2.check('cam-7', await signature(await jpg(view(150, 0))), 62_000)?.type === 'camera_moved');
  ok('битый файл не ломает запуск', new CameraGuard({ file: '/нет/такого/файла.json' }).hasReference('x') === false);
}

console.log(`\n  Пройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);
