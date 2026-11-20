import sharp from 'sharp';
import { MotionCounter, CountFusion } from './motioncount.js';
import { W, H } from './shelfchange.js';

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } };
const section = s => console.log(`\n=== ${s} ===\n`);

const LINE = { id: 'l', inside: 'left', x1: 0, y1: 0.5, x2: 1, y2: 0.5 };
function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// плитка пола; люди — тёмные прямоугольники; patch — светлое пятно на полу
function scene({ people = [], gain = 1, noise = 0, seed = 1, patch = null, shiftX = 0 } = {}) {
  const g = new Uint8Array(W * H), r = rnd(seed);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xs = x + shiftX;
    let v = (xs % 64 < 3 || y % 40 < 3) ? 120 : 165 + ((xs >> 6) + (y / 40 | 0)) % 3 * 8;
    const nx = x / W, ny = y / H;
    if (patch && Math.hypot(nx - patch.x, (ny - patch.y) * H / W) < 0.06) v += 45;
    for (const p of people) if (Math.abs(nx - p.x) < 0.035 && Math.abs(ny - p.y) < 0.09) v = 45;
    v = v * gain + (noise ? (r() - 0.5) * 2 * noise : 0);
    g[y * W + x] = Math.max(0, Math.min(255, v));
  }
  return g;
}
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const calm = rep(8, () => ({ gray: scene() }));
const box = p => ({ cls: 'person', conf: 0.9, x1: p.x - 0.04, x2: p.x + 0.04, y1: p.y - 0.1, y2: p.y + 0.1 });

function run(frames, { det = [] } = {}) {
  const mc = new MotionCounter({ lines: [LINE] }), fu = new CountFusion({ lines: mc.counter.lines });
  const motion = [], total = []; let t = 0;
  for (const f of [...frames, ...rep(15, () => ({ gray: scene() }))]) {
    t += 200;
    const me = mc.step(f.gray, t, f.dets || []);
    motion.push(...me);
    const de = det.filter(d => d.at === t);
    total.push(...fu.push(de, de.map(d => ({ id: d.trackId, box: d.box })), me, t));
  }
  const n = (a, dir) => a.filter(e => e.direction === dir).length;
  return { mc, motion, total, in: n(total, 'in'), out: n(total, 'out') };
}
const down = (x, from = 0.15, n = 16) => rep(n, i => ({ x, y: from + i * 0.045 }));
const up = (x, from = 0.85, n = 16) => rep(n, i => ({ x, y: from - i * 0.045 }));

section('Человек, которого детектор не узнал');
{
  let r = run([...calm, ...down(0.4).map(p => ({ gray: scene({ people: [p] }) }))]);
  ok(r.total.length === 1 && r.total[0].source === 'motion', 'прошёл через линию — один проход по движению');
  const dirDown = r.total[0].direction;
  r = run([...calm, ...up(0.4).map(p => ({ gray: scene({ people: [p] }) }))]);
  ok(r.total.length === 1 && r.total[0].direction !== dirDown, 'в обратную сторону — направление другое');
  const a = down(0.25), b = up(0.75);
  r = run([...calm, ...a.map((p, i) => ({ gray: scene({ people: [p, b[i]] }) }))]);
  ok(r.in === 1 && r.out === 1, 'двое навстречу в разных местах — вход и выход');
  r = run([...calm, ...down(0.4, 0.15, 6).map(p => ({ gray: scene({ people: [p] }) }))]);
  ok(r.total.length === 0, 'подошёл к линии и не пересёк — не считается');
  r = run([...calm, ...down(0.4).map((p, i) => ({ gray: scene({ people: [p], noise: 10, seed: i + 3 }) }))]);
  ok(r.total.length === 1, 'при шуме камеры проход считается так же');
  r = run([...calm, ...down(0.4).map((p, i) => ({ gray: scene({ people: [p], gain: i < 8 ? 1 : 0.8 }) }))]);
  ok(r.total.length <= 1, 'свет сменился посреди прохода — лишних проходов нет');
}

section('Двойного счёта нет');
{
  const path = down(0.4);
  const frames = [...calm, ...path.map(p => ({ gray: scene({ people: [p] }) }))];
  const probe = run(frames).total[0];
  const detEv = (dt, x = 0.4, dir = probe.direction) => [{ lineId: 'l', direction: dir, trackId: 7, at: probe.at + dt, box: { x1: x - 0.04, x2: x + 0.04, y1: 0.4, y2: 0.55 } }];
  let r = run(frames, { det: detEv(-400) });
  ok(r.total.length === 1 && !r.total[0].source, 'детектор посчитал раньше — движение не добавляет');
  r = run(frames, { det: detEv(600) });
  ok(r.total.length === 1 && !r.total[0].source, 'детектор посчитал позже — движение отменяется');
  r = run(frames, { det: detEv(200, 0.4, probe.direction === 'in' ? 'out' : 'in') });
  ok(r.total.length === 1, 'то же место, обратное направление — тоже один проход');
  r = run(frames, { det: detEv(200, 0.85) });
  ok(r.total.length === 2, 'детектор посчитал другого человека в другом месте — оба в счёте');
  r = run([...calm, ...path.map(p => ({ gray: scene({ people: [p] }), dets: [box(p)] }))]);
  ok(r.total.length === 0, 'детектор видит человека — движение за него не считает');
  r = run([...calm, ...path.map((p, i) => ({ gray: scene({ people: [p] }), dets: i === 2 ? [box(p)] : [] }))]);
  ok(r.total.length === 1, 'детектор увидел его на одном кадре из шестнадцати — движение досчитывает');
}

section('Что не считается проходом');
{
  ok(run([...calm, ...rep(40, i => ({ gray: scene({ noise: 14, seed: i + 9 }) }))]).total.length === 0, 'пустой пол, шум');
  ok(run([...calm, ...rep(40, i => ({ gray: scene({ gain: i % 10 < 5 ? 1 : 0.7 }) }))]).total.length === 0, 'пустой пол, свет мигает');
  ok(run([...calm, ...rep(40, () => ({ gray: scene({ patch: { x: 0.5, y: 0.5 } }) }))]).total.length === 0, 'на линии появилось солнечное пятно');
  ok(run([...calm, ...rep(40, i => ({ gray: scene({ patch: { x: 0.5, y: i % 8 < 4 ? 0.42 : 0.58 } }) }))]).total.length === 0, 'пятно скачет через линию туда-сюда');
  ok(run([...calm, ...rep(40, i => ({ gray: scene({ people: [{ x: 0.4, y: 0.5 + (i % 2 ? 0.012 : -0.012) }] }) }))]).total.length === 0, 'человек стоит на линии и переминается');
  const r = run([...calm, ...rep(20, i => ({ gray: scene({ shiftX: 30 + (i % 2) * 20 }) }))]);
  ok(r.total.length === 0, 'камеру трясёт — кадры пропускаются');
  const still = rep(60, () => ({ gray: scene({ people: [{ x: 0.4, y: 0.3 }] }) }));
  const rr = run([...calm, ...still, ...rep(20, () => ({ gray: scene() }))]);
  ok(rr.total.length === 0, 'человек долго стоял и ушёл из кадра вбок — «призрак» не считается');
}

section('Склейка счётчиков');
{
  const fu = new CountFusion({ lines: [LINE], windowMs: 2500 });
  const m = (at, pos, direction = 'in') => ({ lineId: 'l', direction, trackId: 1, at, pos, source: 'motion' });
  ok(fu.push([], [], [m(1000, 0.4)], 1000).length === 0, 'проход по движению сразу не выдаётся');
  ok(fu.push([], [], [], 3000).length === 0, 'ждём окно');
  ok(fu.push([], [], [], 3600).length === 1, 'окно прошло — выдан');
  ok(fu.push([], [], [], 5000).length === 0, 'и только один раз');
  const d = { lineId: 'l', direction: 'in', trackId: 5, at: 9000 };
  ok(fu.push([d], [{ id: 5, box: { x1: 0.36, x2: 0.44, y1: 0.3, y2: 0.52 } }], [], 9000).length === 1, 'проход детектора выдаётся сразу');
  fu.push([], [], [m(9800, 0.42)], 9800);
  ok(fu.push([], [], [], 13000).length === 0, 'движение после детектора в том же месте — отброшено');
  fu.push([], [], [m(20000, 0.9)], 20000);
  ok(fu.push([{ ...d, at: 20500 }], [{ id: 5, box: { x1: 0.06, x2: 0.14, y1: 0.3, y2: 0.52 } }], [], 20500).length === 1 && fu.push([], [], [], 23000).length === 1, 'разные места — оба прохода остаются');
}

section('Размер человека и настоящий JPEG');
{
  const mc = new MotionCounter({ lines: [LINE] });
  ok(mc.minSize === 20, 'пока детектор никого не видел — размер по умолчанию');
  mc.learnSize(rep(12, () => ({ conf: 0.9, x1: 0.4, x2: 0.5, y1: 0.3, y2: 0.6 })));
  ok(mc.minSize > 20, 'размер подстраивается под людей на этой камере');
  mc.learnSize(rep(300, () => ({ conf: 0.2, x1: 0, x2: 1, y1: 0, y2: 1 })));
  ok(mc.personBlocks.length === 12, 'неуверенные рамки в расчёт не идут');
  const jpeg = g => sharp(Buffer.from(g), { raw: { width: W, height: H, channels: 1 } }).jpeg({ quality: 85 }).toBuffer();
  const m2 = new MotionCounter({ lines: [LINE] }); let t = 0; const ev = [];
  for (const f of [...calm, ...down(0.4).map(p => ({ gray: scene({ people: [p] }) })), ...calm]) ev.push(...await m2.observe(await jpeg(f.gray), t += 200));
  ok(ev.length === 1, 'через сжатие JPEG проход находится так же');
  ok((await new MotionCounter({ lines: [] }).observe(await jpeg(scene()), 1)).length === 0, 'линия не задана — модуль ничего не делает');
}

console.log(`\nИтого: ${passed} прошло, ${failed} упало\n`);
process.exit(failed ? 1 : 0);
