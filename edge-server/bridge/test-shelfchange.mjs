// Полка: «с полки исчез предмет» — синтетические кадры с известной правдой
import sharp from 'sharp';
import { ShelfChange, W, H, handSpot, judgeVerdict, changeEvidence, decodeGray } from './shelfchange.js';

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };
const section = s => console.log(`\n${s}`);

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// полка: пёстрая выкладка в прямоугольнике 0.40..0.70 × 0.40..0.80, вокруг ровный пол
function scene({ item = true, gain = 1, bias = 0, shadow = null, noise = 0, seed = 1 } = {}) {
  const g = new Uint8Array(W * H); const r = rng(7); const n = rng(seed + 100);
  const tex = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) tex[i] = 60 + Math.floor(r() * 140);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const nx = x / W, ny = y / H; let v = 120;
    if (nx > 0.40 && nx < 0.70 && ny > 0.40 && ny < 0.80) v = tex[(y >> 2) * W + (x >> 2)];   // пятна 4×4
    if (item && nx > 0.52 && nx < 0.56 && ny > 0.55 && ny < 0.62) v = ((x >> 1) + (y >> 1)) % 2 ? 235 : 20; // товар
    else if (!item && nx > 0.52 && nx < 0.56 && ny > 0.55 && ny < 0.62) v = 95;                              // пустое место
    if (shadow) { const d = Math.hypot((nx - shadow.x) / 0.12, (ny - shadow.y) / 0.16); if (d < 1) v *= 1 - 0.3 * (1 - d); }
    v = v * gain + bias + (noise ? (n() - 0.5) * noise : 0);
    g[y * W + x] = Math.max(0, Math.min(255, v));
  }
  return g;
}
const kp = (o = {}) => Array.from({ length: 17 }, (_, i) => o[i] ? { ...o[i], c: 0.9 } : { x: 0, y: 0, c: 0 });
// человек слева от полки, рамка 0.30..0.45
const person = (wrist, extra = {}) => ({ id: 1, box: { x1: 0.30, y1: 0.20, x2: 0.45, y2: 0.95 }, kpts: kp({ 5: { x: 0.34, y: 0.30 }, 6: { x: 0.41, y: 0.30 }, 11: { x: 0.35, y: 0.55 }, 12: { x: 0.40, y: 0.55 }, ...(wrist ? { 10: wrist } : {}), ...extra }) });
const regions = [{ id: 's1', kind: 'shelf', name: 'Полка 1', points: [{ x: 0.40, y: 0.40 }, { x: 0.70, y: 0.40 }, { x: 0.70, y: 0.80 }, { x: 0.40, y: 0.80 }] }];

function run(frames, opts = {}) {
  const sc = new ShelfChange({ regions, ...opts }); let t = 1000; const picks = [], alerts = [];
  for (const f of frames) { t += 200; const r = sc.step(f.gray, f.people || [], t, { bags: f.bags || [] }); picks.push(...r.picks); alerts.push(...r.alerts); }
  return { picks, alerts, sc };
}
const rep = (n, f) => Array.from({ length: n }, (_, i) => (typeof f === 'function' ? f(i) : f));
const empty = rep(8, { gray: scene() });
const reach = { x: 0.54, y: 0.58 };

section('Предмет исчез с полки');
{
  const r = run([...empty, ...rep(3, { gray: scene(), people: [person(reach)] }), ...rep(8, { gray: scene({ item: false }), people: [person({ x: 0.43, y: 0.50 })] })]);
  ok(r.picks.length === 1, 'одно событие «взят предмет»');
  const p = r.picks[0] || {};
  ok(Math.abs(p.cx - 0.54) < 0.03 && Math.abs(p.cy - 0.585) < 0.04, 'место события совпадает с местом товара');
  ok(p.trackId === 1 && p.shelf?.name === 'Полка 1', 'событие привязано к человеку и полке');
}

section('Куда ушла рука');
{
  const bag = { cls: 'backpack', x1: 0.30, y1: 0.50, x2: 0.40, y2: 0.75 };
  const r = run([...empty, ...rep(3, { gray: scene(), people: [person(reach)] }), ...rep(6, { gray: scene({ item: false }), people: [person({ x: 0.44, y: 0.45 })] }), ...rep(4, { gray: scene({ item: false }), people: [person({ x: 0.35, y: 0.62 })], bags: [bag] })]);
  ok(r.alerts.length === 1 && r.alerts[0].where === 'bag', 'рука в рюкзаке → тревога «в сумку»');
  const r2 = run([...empty, ...rep(3, { gray: scene(), people: [person(reach)] }), ...rep(6, { gray: scene({ item: false }), people: [person({ x: 0.44, y: 0.45 })] }), ...rep(30, { gray: scene({ item: false }), people: [person({ x: 0.375, y: 0.45 })] })]);
  ok(r2.alerts.length === 1 && r2.alerts[0].where === 'body', 'рука у торса → тревога «к телу» по истечении окна');
  const r3 = run([...empty, ...rep(3, { gray: scene(), people: [person(reach)] }), ...rep(36, { gray: scene({ item: false }), people: [person({ x: 0.44, y: 0.25 })] })]);
  ok(r3.picks.length === 1 && r3.alerts.length === 0, 'предмет в поднятой руке → событие есть, тревоги нет');
}

section('Не кража');
{
  ok(run([...empty, ...rep(20, { gray: scene(), people: [person(reach)] })]).picks.length === 0, 'человек тянется к полке, но ничего не берёт');
  ok(run([...empty, ...rep(20, i => ({ gray: scene({ gain: 0.75 }), people: [person(reach)] }))]).picks.length === 0, 'свет стал темнее на 25 %');
  ok(run([...empty, ...rep(20, i => ({ gray: scene({ gain: 1.2, bias: 8 }), people: [person(reach)] }))]).picks.length === 0, 'свет стал ярче');
  ok(run([...empty, ...rep(20, i => ({ gray: scene({ shadow: { x: 0.50 + i * 0.004, y: 0.6 } }), people: [person(reach)] }))]).picks.length === 0, 'мягкая движущаяся тень на полке');
  ok(run([...empty, ...rep(20, i => ({ gray: scene({ noise: 10, seed: i }), people: [person(reach)] }))]).picks.length === 0, 'шум камеры');
  ok(run([...empty, ...rep(3, { gray: scene(), people: [person({ x: 0.33, y: 0.30 })] }), ...rep(10, { gray: scene({ item: false }), people: [person({ x: 0.33, y: 0.30 })] })]).picks.length === 0, 'изменение далеко от руки не считается');
  ok(run([...empty, ...rep(20, { gray: scene({ item: false }) })]).picks.length === 0, 'изменение без людей рядом — эталон просто обновляется');
}

section('Человек стоял у полки с самого начала');
{
  const cover = { id: 2, box: { x1: 0.48, y1: 0.30, x2: 0.60, y2: 0.90 }, kpts: kp({ 10: { x: 0.54, y: 0.58 } }) };
  const r = run([...rep(6, { gray: scene(), people: [cover] }), ...rep(20, { gray: scene(), people: [person({ x: 0.43, y: 0.5 })] })]);
  ok(r.picks.length === 0, 'место, открывшееся после ухода человека, не считается взятым предметом');
}

section('Повторы и окно слежения');
{
  const r = run([...empty, ...rep(3, { gray: scene(), people: [person(reach)] }), ...rep(40, { gray: scene({ item: false }), people: [person({ x: 0.44, y: 0.45 })] })]);
  ok(r.picks.length === 1, 'одно и то же изменение не сообщается повторно');
  ok(r.sc.following === false, 'слежение за рукой заканчивается');
}

section('Положение руки и вердикт облака');
{
  ok(handSpot(person({ x: 0.35, y: 0.62 }), [{ cls: 'handbag', x1: 0.30, y1: 0.5, x2: 0.4, y2: 0.75 }]) === 'bag', 'кисть в рамке сумки');
  ok(handSpot(person({ x: 0.375, y: 0.45 }), []) === 'body', 'кисть у торса');
  ok(handSpot(person({ x: 0.60, y: 0.20 }), []) === null, 'кисть в стороне');
  ok(handSpot(person({ x: 0.35, y: 0.62 }), [{ cls: 'chair', x1: 0.30, y1: 0.5, x2: 0.4, y2: 0.75 }]) !== 'bag', 'посторонний предмет не считается сумкой');
  ok(judgeVerdict(null).send === true, 'облако недоступно → тревога уходит с пометкой');
  ok(judgeVerdict({ item_taken: false, confidence: 0.9 }).send === false, 'облако уверено, что предмет на месте → тревога снята');
  ok(judgeVerdict({ item_taken: true, concealed: false, confidence: 0.8 }).send === false, 'предмет в руке или корзине → тревога снята');
  ok(judgeVerdict({ item_taken: false, confidence: 0.4 }).send === true, 'неуверенный ответ облака тревогу не снимает');
  ok(judgeVerdict({ item_taken: true, concealed: true, confidence: 0.8, comment: 'коробка убрана в рюкзак' }).note.includes('рюкзак'), 'комментарий облака попадает в описание');
}

section('Настоящий JPEG и снимок-доказательство');
{
  const jpeg = g => sharp(Buffer.from(g), { raw: { width: W, height: H, channels: 1 } }).jpeg({ quality: 88 }).toBuffer();
  const a = await jpeg(scene()), b = await jpeg(scene({ item: false }));
  const sc = new ShelfChange({ regions }); let t = 0; const picks = [];
  for (let i = 0; i < 8; i++) picks.push(...(await sc.observe(a, [], t += 200)).picks);
  for (let i = 0; i < 3; i++) picks.push(...(await sc.observe(a, [person(reach)], t += 200)).picks);
  for (let i = 0; i < 8; i++) picks.push(...(await sc.observe(b, [person({ x: 0.43, y: 0.5 })], t += 200)).picks);
  ok(picks.length === 1, 'через сжатие JPEG событие находится так же');
  ok(Buffer.isBuffer(picks[0]?.before), 'кадр «до» сохранён');
  const img = await changeEvidence(picks[0], b, a); const meta = await sharp(img).metadata();
  ok(meta.width === 1920 && meta.height === 360, 'доказательство — три панели: до, после, рука');
  ok((await decodeGray(a)).length === W * H, 'кадр приводится к рабочему размеру');
  const none = new ShelfChange({ regions: [] });
  ok((await none.observe(a, [person(reach)], 1)).picks.length === 0, 'без размеченных полок модуль молчит');
}

console.log(`\nПройдено: ${pass}, провалено: ${fail}`);
process.exit(fail ? 1 : 0);
