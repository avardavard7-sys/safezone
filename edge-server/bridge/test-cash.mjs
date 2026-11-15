import { CashWatch } from './cash.js';

let passed = 0, failed = 0; const out = [];
const t = (n, f) => { try { f(); passed++; out.push(`  ok   ${n}`); } catch (e) { failed++; out.push(`  FAIL ${n}\n         ${e.message}`); } };
const eq = (a, b, w = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${w} ожидалось ${JSON.stringify(b)}, пришло ${JSON.stringify(a)}`); };

// кассир стоит слева (x≈0.3), ящик перед ним, покупатель — справа за прилавком
const DRAWER = { id: 'd', kind: 'cash_drawer', name: 'Касса 1', points: [[0.35, 0.45], [0.55, 0.45], [0.55, 0.6], [0.35, 0.6]] };
const CUSTOMER = { id: 'c', kind: 'cash_customer', points: [[0.65, 0.1], [0.98, 0.1], [0.98, 0.98], [0.65, 0.98]] };
const R = [DRAWER, CUSTOMER];

function cashier({ rw, hips = true, conf = 0.9 }) {
  const cx = 0.3;
  const k = Array.from({ length: 17 }, () => ({ x: cx, y: 0.3, c: conf }));
  k[5] = { x: cx - 0.06, y: 0.35, c: conf }; k[6] = { x: cx + 0.06, y: 0.35, c: conf };
  k[11] = { x: cx - 0.05, y: 0.6, c: hips ? conf : 0.1 }; k[12] = { x: cx + 0.05, y: 0.6, c: hips ? conf : 0.1 };
  k[9] = { x: cx - 0.07, y: 0.68, c: conf };
  k[10] = { ...rw, c: conf };
  return { id: 1, group: 'person', box: { x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.95 }, kpts: k, vx: 0, vy: 0 };
}
const customer = () => ({ id: 2, group: 'person', box: { x1: 0.75, y1: 0.2, x2: 0.9, y2: 0.9 }, kpts: null });
const IN_DRAWER = { x: 0.45, y: 0.52 }, POCKET = { x: 0.36, y: 0.61 }, REST = { x: 0.37, y: 0.68 }, TO_CUSTOMER = { x: 0.72, y: 0.5 };

function play(w, frames, step = 300) {
  const alerts = [];
  frames.forEach((f, i) => {
    const at = i * step;
    const tracks = [cashier(f), ...(f.cust ? [customer()] : [])].map(tr => ({ ...tr, lastSeen: at }));
    alerts.push(...w.observe(tracks, at, Buffer.from('кадр' + i)));
  });
  return alerts;
}
const fr = (rw, extra = {}) => ({ rw, ...extra });
const empty = n => Array(n).fill(fr(REST));

console.log('\n=== Касса ===\n');

t('рука в ящике 2 с, покупателя нет — «касса без покупателя»', () => {
  const a = play(new CashWatch({ regions: R }), [...empty(20), ...Array(8).fill(fr(IN_DRAWER))]);
  eq(a.map(x => x.kind), ['no_customer']); eq(a[0].drawer.name, 'Касса 1');
});
t('рука в ящике, покупатель у кассы — тревоги нет', () => {
  eq(play(new CashWatch({ regions: R }), Array(12).fill(fr(IN_DRAWER, { cust: true }))).length, 0);
});
t('покупатель только что отошёл (меньше 5 с) — тревоги нет', () => {
  const frames = [...Array(4).fill(fr(REST, { cust: true })), ...Array(8).fill(fr(IN_DRAWER))];
  eq(play(new CashWatch({ regions: R }), frames).length, 0);
});
t('коснулся ящика на мгновение — тревоги нет', () => {
  eq(play(new CashWatch({ regions: R }), [...empty(20), fr(IN_DRAWER), fr(IN_DRAWER), ...empty(5)]).length, 0);
});
t('зона покупателя не размечена — правило «без покупателя» молчит', () => {
  eq(play(new CashWatch({ regions: [DRAWER] }), [...empty(20), ...Array(10).fill(fr(IN_DRAWER))]).length, 0);
});
t('повторное открытие в течение 2 минут — одна тревога', () => {
  eq(play(new CashWatch({ regions: R }), [...empty(20), ...Array(8).fill(fr(IN_DRAWER)), ...empty(4), ...Array(8).fill(fr(IN_DRAWER))]).length, 1);
});

t('из ящика к карману, бёдра видны — «к карману»', () => {
  const a = play(new CashWatch({ regions: R }), [fr(IN_DRAWER, { cust: true }), fr(POCKET, { cust: true }), fr(POCKET, { cust: true }), fr(POCKET, { cust: true })]);
  eq(a.map(x => x.kind), ['pocket']); eq(a[0].reach.frame.toString(), 'кадр0');
});
t('из ящика к покупателю (сдача) — тревоги нет', () => {
  eq(play(new CashWatch({ regions: R }), [fr(IN_DRAWER, { cust: true }), fr(TO_CUSTOMER, { cust: true }), fr(TO_CUSTOMER, { cust: true }), fr(REST, { cust: true })]).length, 0);
});
t('камера сверху, бёдер не видно — «к карману» не решаем', () => {
  const frames = [IN_DRAWER, POCKET, POCKET, POCKET].map(rw => ({ rw, hips: false, cust: true }));
  eq(play(new CashWatch({ regions: R }), frames).length, 0);
});
t('руки спокойно вдоль тела после ящика — тревоги нет', () => {
  eq(play(new CashWatch({ regions: R }), [fr(IN_DRAWER, { cust: true }), fr(REST, { cust: true }), fr(REST, { cust: true }), fr(REST, { cust: true })]).length, 0);
});
t('кисть видна плохо — ничего не решаем', () => {
  const frames = [...empty(20), ...Array(8).fill({ rw: IN_DRAWER, conf: 0.3 })];
  eq(play(new CashWatch({ regions: R }), frames).length, 0);
});
t('ящика не размечено — модуль ничего не делает', () => {
  eq(play(new CashWatch({ regions: [CUSTOMER] }), Array(10).fill(fr(IN_DRAWER))).length, 0);
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
process.exit(failed ? 1 : 0);
