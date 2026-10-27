import { LineCounter, crossing, sideOf, footPoint } from './counter.js';

let passed = 0, failed = 0;
const out = [];
const t = (name, fn) => { try { fn(); passed++; out.push(`  ok   ${name}`); } catch (e) { failed++; out.push(`  FAIL ${name}\n         ${e.message}`); } };
const eq = (a, b, w = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${w} ожидалось ${JSON.stringify(b)}, пришло ${JSON.stringify(a)}`); };

// горизонтальная линия порога посередине кадра, «внутри» — ниже линии (камера смотрит на вход сверху-спереди)
const DOOR = { id: 'door', x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, inside: 'left' };

function person(id, footX, footY, h = 0.3) {
  return { id, group: 'person', box: { x1: footX - 0.05, y1: footY - h, x2: footX + 0.05, y2: footY } };
}
function walk(counter, id, path, t0 = 0, stepMs = 200) {
  const ev = [];
  path.forEach(([x, y], i) => {
    const tr = person(id, x, y); tr.lastSeen = t0 + i * stepMs;
    ev.push(...counter.observe([tr], tr.lastSeen));
  });
  return ev;
}

console.log('\n=== Подсчёт посетителей ===\n');

t('сторона внутри определяется по линии', () => {
  eq(sideOf(DOOR, { x: 0.5, y: 0.7 }) > 0, true, 'ниже линии — левая сторона:');
});
t('шаг через линию вниз — вход', () => eq(crossing(DOOR, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.6 }), 'in'));
t('шаг через линию вверх — выход', () => eq(crossing(DOOR, { x: 0.5, y: 0.6 }, { x: 0.5, y: 0.4 }), 'out'));
t('шаг мимо отрезка линии не считается', () => eq(crossing(DOOR, { x: 0.95, y: 0.4 }, { x: 0.95, y: 0.6 }), null));
t('сменили сторону «внутри» — вход и выход меняются местами', () => {
  eq(crossing({ ...DOOR, inside: 'right' }, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.6 }), 'out');
});
t('точка — у ног, а не в центре рамки', () => eq(footPoint(person(1, 0.5, 0.8)), { x: 0.5, y: 0.8 }));

t('человек вошёл — ровно один вход', () => {
  const c = new LineCounter({ lines: [DOOR] });
  const ev = walk(c, 1, [[0.5, 0.2], [0.5, 0.3], [0.5, 0.4], [0.5, 0.55], [0.5, 0.65], [0.5, 0.8]]);
  eq(ev.map(e => e.direction), ['in']);
});
t('вошёл и вышел — вход и выход', () => {
  const c = new LineCounter({ lines: [DOOR] });
  const ev = walk(c, 1, [[0.5, 0.3], [0.5, 0.4], [0.5, 0.6], [0.5, 0.7], [0.5, 0.6], [0.5, 0.4], [0.5, 0.3]]);
  eq(ev.map(e => e.direction), ['in', 'out']);
});
t('топчется на пороге — ни одного лишнего события', () => {
  const c = new LineCounter({ lines: [DOOR] });
  const ev = walk(c, 1, [[0.5, 0.3], [0.5, 0.495], [0.5, 0.505], [0.5, 0.497], [0.5, 0.503], [0.5, 0.499], [0.5, 0.501], [0.5, 0.3]]);
  eq(ev.length, 0);
});
t('шагнул внутрь и замялся у порога — один вход', () => {
  const c = new LineCounter({ lines: [DOOR] });
  const ev = walk(c, 1, [[0.5, 0.3], [0.5, 0.4], [0.5, 0.6], [0.5, 0.51], [0.5, 0.6], [0.5, 0.51], [0.5, 0.7]]);
  eq(ev.map(e => e.direction), ['in']);
});
t('прошёл вдоль линии, не пересекая — ноль', () => {
  const c = new LineCounter({ lines: [DOOR] });
  eq(walk(c, 1, [[0.2, 0.7], [0.4, 0.7], [0.6, 0.7], [0.8, 0.7]]).length, 0);
});
t('двое входят одновременно — два входа', () => {
  const c = new LineCounter({ lines: [DOOR] });
  const steps = [0.3, 0.4, 0.6, 0.7];
  const ev = [];
  steps.forEach((y, i) => {
    const a = person(1, 0.3, y), b = person(2, 0.7, y);
    a.lastSeen = b.lastSeen = i * 200;
    ev.push(...c.observe([a, b], i * 200));
  });
  eq(ev.map(e => `${e.trackId}:${e.direction}`).sort(), ['1:in', '2:in']);
});
t('первое появление трека уже за линией не считается входом', () => {
  const c = new LineCounter({ lines: [DOOR] });
  eq(walk(c, 1, [[0.5, 0.8], [0.5, 0.85]]).length, 0);
});
t('трек, потерянный в прошлом кадре, не обновляет положение', () => {
  const c = new LineCounter({ lines: [DOOR] });
  const tr = person(1, 0.5, 0.3); tr.lastSeen = 0; c.observe([tr], 0);
  const stale = person(1, 0.5, 0.7); stale.lastSeen = 0;
  eq(c.observe([stale], 200).length, 0, 'устаревший трек дал событие:');
});
t('сумки и прочие объекты не считаются', () => {
  const c = new LineCounter({ lines: [DOOR] });
  const ev = [];
  [[0.5, 0.3], [0.5, 0.7]].forEach(([x, y], i) => {
    const bag = { ...person(9, x, y), group: 'bag', lastSeen: i * 200 };
    ev.push(...c.observe([bag], i * 200));
  });
  eq(ev.length, 0);
});
t('слишком короткая линия отбрасывается', () => {
  eq(new LineCounter({ lines: [{ id: 'x', x1: 0.5, y1: 0.5, x2: 0.505, y2: 0.5, inside: 'left' }] }).lines.length, 0);
});
t('линии из базы приходят строками — числа разбираются', () => {
  const c = new LineCounter({ lines: [{ id: 'd', x1: '0.1', y1: '0.5', x2: '0.9', y2: '0.5', inside: 'left' }] });
  eq(walk(c, 1, [[0.5, 0.3], [0.5, 0.4], [0.5, 0.6], [0.5, 0.7]]).map(e => e.direction), ['in']);
});
t('две линии — каждая считает своё', () => {
  const side = { id: 'side', x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.9, inside: 'left' };
  const c = new LineCounter({ lines: [DOOR, side] });
  const ev = walk(c, 1, [[0.3, 0.3], [0.4, 0.4], [0.6, 0.6], [0.7, 0.7]]);
  eq(ev.map(e => `${e.lineId}:${e.direction}`).sort(), ['door:in', 'side:out']);
});
t('память о старых треках чистится', () => {
  const c = new LineCounter({ lines: [DOOR] });
  walk(c, 1, [[0.5, 0.3], [0.5, 0.4]]);
  const tr = person(2, 0.5, 0.3); tr.lastSeen = 60_000; c.observe([tr], 60_000);
  eq([...c.state.keys()].some(k => k.startsWith('1:')), false);
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
process.exit(failed ? 1 : 0);
