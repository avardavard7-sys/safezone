import { ShelfWatch, pointInPolygon, bodyFrame, concealSpot, isReaching } from './shelf.js';

let passed = 0, failed = 0; const out = [];
const t = (n, f) => { try { f(); passed++; out.push(`  ok   ${n}`); } catch (e) { failed++; out.push(`  FAIL ${n}\n         ${e.message}`); } };
const eq = (a, b, w = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${w} ожидалось ${JSON.stringify(b)}, пришло ${JSON.stringify(a)}`); };

// человек стоит по центру: плечи y=0.35, бёдра y=0.6 → длина торса 0.25
function skel(cx, { lw, rw, conf = 0.9 } = {}) {
  const k = Array.from({ length: 17 }, () => ({ x: cx, y: 0.3, c: conf }));
  k[5] = { x: cx - 0.06, y: 0.35, c: conf }; k[6] = { x: cx + 0.06, y: 0.35, c: conf };
  k[11] = { x: cx - 0.05, y: 0.6, c: conf }; k[12] = { x: cx + 0.05, y: 0.6, c: conf };
  k[9] = { ...(lw || { x: cx - 0.07, y: 0.68 }), c: conf };
  k[10] = { ...(rw || { x: cx + 0.07, y: 0.68 }), c: conf };
  return k;
}
const SHELF = { id: 's1', kind: 'shelf', name: 'Стеллаж 3', points: [[0.75, 0.2], [0.95, 0.2], [0.95, 0.75], [0.75, 0.75]] };
function play(watch, frames, { id = 1, cx = 0.5, v = 0, step = 300, t0 = 0 } = {}) {
  const alerts = [];
  frames.forEach((rw, i) => {
    const at = t0 + i * step;
    const tr = { id, group: 'person', lastSeen: at, vx: v, vy: 0, box: { x1: cx - 0.1, y1: 0.2, x2: cx + 0.1, y2: 0.95 }, kpts: skel(cx, { rw }) };
    alerts.push(...watch.observe([tr], at, Buffer.from('кадр' + i)));
  });
  return alerts;
}
const REACH = { x: 0.85, y: 0.42 };
const POCKET = { x: 0.56, y: 0.61 };
const CHEST = { x: 0.5, y: 0.5 };
const NEUTRAL = { x: 0.68, y: 0.45 };
const HANG = { x: 0.57, y: 0.67 };

console.log('\n=== Кража с полки: подозрение на сокрытие ===\n');

t('точка в многоугольнике полки', () => eq([pointInPolygon({ x: 0.8, y: 0.3 }, SHELF.points), pointInPolygon({ x: 0.5, y: 0.3 }, SHELF.points)], [true, false]));
t('вытянутая к полке рука — касание; висящая вдоль тела — нет', () => {
  const f = bodyFrame(skel(0.5), 0.35);
  eq([isReaching(REACH, f, 'right'), isReaching(HANG, f, 'right')], [true, false]);
});
t('рука у бедра — «карман», висящая — ничего; грудь — только если явно включено', () => {
  const f = bodyFrame(skel(0.5), 0.35);
  eq([concealSpot(POCKET, f), concealSpot(HANG, f), concealSpot(CHEST, f), concealSpot(CHEST, f, { torso: true })], ['карман', null, null, 'под одежду']);
});
t('рука у лица (телефон, очки) — не касание полки, даже если лицо «в зоне полки»', () => {
  const f = bodyFrame(skel(0.5), 0.35);
  eq(isReaching({ x: 0.52, y: 0.22 }, f, 'right'), false);
});
t('взял с полки и держит перед грудью, читает этикетку — тревоги нет', () => {
  eq(play(new ShelfWatch({ regions: [SHELF] }), [REACH, CHEST, CHEST, CHEST, CHEST]).length, 0);
});

t('взял с полки → в карман, стоя → тревога «карман»', () => {
  const a = play(new ShelfWatch({ regions: [SHELF] }), [NEUTRAL, REACH, NEUTRAL, POCKET, POCKET, POCKET]);
  eq(a.length, 1); eq([a[0].spot, a[0].shelf.name, a[0].hand], ['карман', 'Стеллаж 3', 'right']);
});
t('«под одежду» работает, если объект включил его явно', () => {
  const a = play(new ShelfWatch({ regions: [SHELF], torso: true }), [REACH, CHEST, CHEST, CHEST]);
  eq(a.map(x => x.spot), ['под одежду']);
});
t('в тревоге сохранён кадр момента у полки — для снимка из двух кадров', () => {
  const a = play(new ShelfWatch({ regions: [SHELF] }), [NEUTRAL, REACH, POCKET, POCKET, POCKET]);
  eq(a[0].reach.frame.toString(), 'кадр1');
});

t('прошёл мимо полки, рука висит в «зоне полки» — тревоги нет', () => {
  const low = { id: 's2', kind: 'shelf', points: [[0.5, 0.55], [0.7, 0.55], [0.7, 0.8], [0.5, 0.8]] };
  eq(play(new ShelfWatch({ regions: [low] }), [HANG, HANG, HANG, HANG, HANG]).length, 0);
});
t('рука в карман без касания полки (телефон, ключи) — тревоги нет', () => {
  eq(play(new ShelfWatch({ regions: [SHELF] }), [NEUTRAL, POCKET, POCKET, POCKET, POCKET]).length, 0);
});
t('взял и вернул, рука не пошла к телу — тревоги нет', () => {
  eq(play(new ShelfWatch({ regions: [SHELF] }), [REACH, NEUTRAL, REACH, NEUTRAL, NEUTRAL, NEUTRAL]).length, 0);
});
t('взял, а к карману рука пошла через 5 секунд — тревоги нет', () => {
  const w = new ShelfWatch({ regions: [SHELF] });
  eq(play(w, [REACH, NEUTRAL, ...Array(16).fill(NEUTRAL), POCKET, POCKET, POCKET]).length, 0);
});
t('рука на мгновение у бедра и дальше — тревоги нет (нужно задержаться)', () => {
  eq(play(new ShelfWatch({ regions: [SHELF] }), [REACH, POCKET, NEUTRAL, NEUTRAL]).length, 0);
});
t('идёт быстрым шагом — тревоги нет', () => {
  eq(play(new ShelfWatch({ regions: [SHELF] }), [REACH, POCKET, POCKET, POCKET], { v: 0.3 }).length, 0);
});
t('скелет виден плохо — ничего не решаем', () => {
  const w = new ShelfWatch({ regions: [SHELF] });
  const alerts = [];
  [REACH, POCKET, POCKET, POCKET].forEach((rw, i) => {
    const tr = { id: 1, group: 'person', lastSeen: i * 300, vx: 0, vy: 0, box: { x1: 0.4, y1: 0.2, x2: 0.6, y2: 0.95 }, kpts: skel(0.5, { rw, conf: 0.2 }) };
    alerts.push(...w.observe([tr], i * 300));
  });
  eq(alerts.length, 0);
});
t('повтор в течение минуты — одна тревога, без спама', () => {
  eq(play(new ShelfWatch({ regions: [SHELF] }), [REACH, POCKET, POCKET, POCKET, REACH, POCKET, POCKET, POCKET]).length, 1);
});
t('тянется к верхней полке выше плеча — тоже касание', () => {
  const top = { id: 's3', kind: 'shelf', points: [[0.5, 0.0], [0.75, 0.0], [0.75, 0.12], [0.5, 0.12]] };
  eq(play(new ShelfWatch({ regions: [top] }), [{ x: 0.62, y: 0.05 }, POCKET, POCKET, POCKET]).length, 1);
});
t('двое у полки — тревога только на того, кто прятал', () => {
  const w = new ShelfWatch({ regions: [SHELF] });
  const alerts = [];
  const seq = [[REACH, REACH], [POCKET, NEUTRAL], [POCKET, NEUTRAL], [POCKET, NEUTRAL]];
  seq.forEach(([a, b], i) => {
    const at = i * 300;
    const mk = (id, rw) => ({ id, group: 'person', lastSeen: at, vx: 0, vy: 0, box: { x1: 0.4, y1: 0.2, x2: 0.6, y2: 0.95 }, kpts: skel(0.5, { rw }) });
    alerts.push(...w.observe([mk(1, a), mk(2, b)], at));
  });
  eq(alerts.map(x => x.trackId), [1]);
});
t('зоны другого вида (касса) полкой не считаются', () => {
  eq(new ShelfWatch({ regions: [{ ...SHELF, kind: 'cash_drawer' }] }).shelves.length, 0);
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
process.exit(failed ? 1 : 0);
