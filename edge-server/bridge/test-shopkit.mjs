import { QueueWatch, HeatAccumulator, inQuietHours, reportDue, formatReport, judgeReturn } from './shopkit.js';
import { CashWatch } from './cash.js';
let passed = 0, failed = 0; const out = [];
const t = (n, f) => { try { f(); passed++; out.push(`  ok   ${n}`); } catch (e) { failed++; out.push(`  FAIL ${n}\n         ${e.message}`); } };
const eq = (a, b, w = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${w} ожидалось ${JSON.stringify(b)}, пришло ${JSON.stringify(a)}`); };
const person = (x, y) => ({ x1: x - 0.03, y1: y - 0.25, x2: x + 0.03, y2: y });
const Q = { id: 'q', kind: 'queue', name: 'Касса 1', points: [[0.1, 0.5], [0.5, 0.5], [0.5, 0.95], [0.1, 0.95]] };
const crowd = n => Array.from({ length: n }, (_, i) => person(0.15 + i * 0.05, 0.8));
// 10:00 по Алматы = 05:00 UTC
const at = (h, m = 0) => Date.UTC(2026, 9, 27, h - 5, m);

console.log('\n=== Очередь, тепловая карта, тихие часы, отчёт ===\n');
t('в очереди считаются только те, кто стоит в зоне очереди', () => {
  const r = new QueueWatch({ regions: [Q] }).observe([...crowd(3), person(0.8, 0.8)], 0);
  eq(r.samples[0].people, 3);
});
t('замер — раз в минуту, а не на каждый кадр', () => {
  const w = new QueueWatch({ regions: [Q] }); let n = 0;
  for (let s = 0; s <= 125; s += 5) n += w.observe(crowd(2), s * 1000).samples.length;
  eq(n, 3);
});
t('мелькнувший человек не меняет очередь — медиана за 10 секунд', () => {
  const w = new QueueWatch({ regions: [Q], sampleMs: 1 });
  [2, 2, 2, 7, 2].forEach((n, i) => w.observe(crowd(n), i * 1000));
  eq(w.observe(crowd(2), 5000).samples[0].people, 2);
});
t('очередь 5+ держится 2 минуты → одна тревога «откройте ещё кассу»', () => {
  const w = new QueueWatch({ regions: [Q] }); const alerts = [];
  for (let s = 0; s <= 400; s += 5) alerts.push(...w.observe(crowd(6), s * 1000).alerts);
  eq([alerts.length, alerts[0].people, alerts[0].name], [1, 6, 'Касса 1']);
});
t('очередь 5+ меньше двух минут — тревоги нет', () => {
  const w = new QueueWatch({ regions: [Q] }); const alerts = [];
  for (let s = 0; s <= 100; s += 5) alerts.push(...w.observe(crowd(6), s * 1000).alerts);
  for (let s = 105; s <= 300; s += 5) alerts.push(...w.observe(crowd(1), s * 1000).alerts);
  eq(alerts.length, 0);
});

t('тепловая карта: ноги человека попадают в свою клетку сетки 32×18', () => {
  const h = new HeatAccumulator(); h.add('c', [person(0.5, 0.5), person(0.01, 0.99)], at(10));
  const b = h.drain()[0];
  eq([b.cells[Math.floor(0.5 * 18) * 32 + 16], b.cells[17 * 32 + 0], b.samples, b.cells.length], [1, 1, 1, 576]);
});
t('тепловая карта: часы раздельно, после выгрузки накопление с нуля', () => {
  const h = new HeatAccumulator(); h.add('c', [person(0.5, 0.5)], at(10, 10)); h.add('c', [person(0.5, 0.5)], at(11, 5));
  eq([h.drain().length, h.drain().length], [2, 0]);
});

t('тихие часы 09:00–09:30: 09:10 — тихо, 09:40 — нет', () => {
  const r = [{ from: '09:00', to: '09:30' }];
  eq([inQuietHours(r, at(9, 10)), inQuietHours(r, at(9, 40))], [true, false]);
});
t('тихие часы через полночь 23:30–00:30', () => {
  const r = [{ from: '23:30', to: '00:30' }];
  eq([inQuietHours(r, at(23, 45)), inQuietHours(r, at(24, 15)), inQuietHours(r, at(13))], [true, true, false]);
});
t('касса в тихие часы: рука в ящике без покупателя — тревоги нет', () => {
  const D = { id: 'd', kind: 'cash_drawer', name: 'Касса', points: [[0.35, 0.45], [0.55, 0.45], [0.55, 0.6], [0.35, 0.6]] };
  const C = { id: 'c', kind: 'cash_customer', points: [[0.65, 0.1], [0.98, 0.1], [0.98, 0.98], [0.65, 0.98]] };
  const k = Array.from({ length: 17 }, () => ({ x: 0.3, y: 0.3, c: 0.9 })); k[10] = { x: 0.45, y: 0.52, c: 0.9 };
  const run = quiet => {
    const w = new CashWatch({ regions: [D, C] }); w.setQuiet(quiet); let n = 0;
    for (let i = 0; i < 30; i++) n += w.observe([{ id: 1, group: 'person', lastSeen: at(9, 10) + i * 300, box: { x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.95 }, kpts: k }], at(9, 10) + i * 300).length;
    return n;
  };
  eq([run([{ from: '09:00', to: '09:30' }]), run([])], [0, 1]);
});

t('отчёт: после закрытия — пора, второй раз в тот же день — нет', () => {
  const dayStart = new Date(at(9)).toISOString();
  eq([reportDue({ nowMs: at(21, 59), dayStart, workStart: '09:00', workEnd: '22:00' }),
      reportDue({ nowMs: at(22, 1), dayStart, workStart: '09:00', workEnd: '22:00' }),
      reportDue({ nowMs: at(22, 1), dayStart, workStart: '09:00', workEnd: '22:00', lastSentFor: dayStart })], [false, true, false]);
});
t('отчёт для ТЦ, работающего до 3 ночи — после 03:00 следующих суток', () => {
  const dayStart = new Date(at(8, 45)).toISOString();
  eq([reportDue({ nowMs: at(23), dayStart, workStart: '08:45', workEnd: '03:00' }),
      reportDue({ nowMs: at(24 + 3, 5), dayStart, workStart: '08:45', workEnd: '03:00' })], [false, true]);
});
t('текст отчёта — по-русски, с типами тревог и проверкой', () => {
  const txt = formatReport({ object: 'Магазин', entries: 120, peak: { count: 18, at: '18:40' }, avg_dwell_min: 14.5, sales: 48, queue_max: 6,
    incidents: [{ type: 'concealment', n: 3, confirmed: 1, false: 2 }, { type: 'fall', n: 1, confirmed: 0, false: 0 }] });
  eq([/Посетителей: <b>120/.test(txt), /конверсия 40%/.test(txt), /сокрытие товара: 3 \(подтверждено 1, ложных 2\)/.test(txt), /падение: 1$/m.test(txt)], [true, true, true, true]);
});
t('день без тревог — так и пишется', () => eq(/Тревог не было/.test(formatReport({ object: 'X', entries: 0, incidents: [] })), true));


const hist = (present, from, to) => Array.from({ length: Math.floor((to - from) / 1000) + 1 }, (_, i) => ({ t: from + i * 1000, present: present(from + i * 1000) }));
const R = 1_000_000;
t('возврат, у кассы никого всю минуту — тревога', () => eq(judgeReturn(R, R + 40000, [hist(() => false, R - 70000, R + 35000)]), 'alert'));
t('возврат, покупатель стоял за 20 секунд до чека — всё в порядке', () => eq(judgeReturn(R, R + 40000, [hist(t => t > R - 25000 && t < R - 15000, R - 70000, R + 35000)]), 'ok'));
t('камера в это время не смотрела — не обвиняем', () => eq(judgeReturn(R, R + 40000, [hist(() => false, R + 100000, R + 200000)]), 'unknown'));
t('чек только что пришёл — ждём полминуты, вдруг покупатель подойдёт', () => eq(judgeReturn(R, R + 5000, [hist(() => false, R - 70000, R + 5000)]), 'wait'));
t('две кассовые камеры: хотя бы одна видела покупателя — в порядке', () =>
  eq(judgeReturn(R, R + 40000, [hist(() => false, R - 70000, R + 35000), hist(t => t === R, R - 70000, R + 35000)]), 'ok'));


t('касса записывает историю: был покупатель или нет, раз в секунду', () => {
  const D = { id: 'd', kind: 'cash_drawer', points: [[0.35, 0.45], [0.55, 0.45], [0.55, 0.6], [0.35, 0.6]] };
  const C = { id: 'c', kind: 'cash_customer', points: [[0.65, 0.1], [0.98, 0.1], [0.98, 0.98], [0.65, 0.98]] };
  const w = new CashWatch({ regions: [D, C] });
  const cust = { id: 2, group: 'person', box: { x1: 0.75, y1: 0.2, x2: 0.9, y2: 0.9 }, kpts: null };
  for (let i = 0; i < 10; i++) w.observe(i < 5 ? [{ ...cust, lastSeen: i * 500 }] : [], i * 500);
  eq(w.presence.map(p => p.present), [true, true, true, false, false]);
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
process.exit(failed ? 1 : 0);
