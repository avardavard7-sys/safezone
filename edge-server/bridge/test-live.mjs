import { planAnalyzers, tracksPayload, Throttle, watchedFromPresence } from './live.js';

let passed = 0, failed = 0; const out = [];
const t = (n, f) => { try { f(); passed++; out.push(`  ok   ${n}`); } catch (e) { failed++; out.push(`  FAIL ${n}\n         ${e.message}`); } };
const eq = (a, b, w = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${w} ожидалось ${JSON.stringify(b)}, пришло ${JSON.stringify(a)}`); };

const cams = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, name: id }));
const lines = [{ id: 'l1', camera_id: 'a' }];
const ALL = { visitor_count: true, people_boxes: true };

console.log('\n=== Рамки в LIVE и потоки анализа ===\n');

t('камера с линией считает, даже если никто не смотрит', () => {
  const p = planAnalyzers({ cams, countLines: lines, features: ALL });
  eq([...p.keys()], ['a']); eq([p.get('a').count, p.get('a').overlay], [true, false]);
});
t('просматриваемая камера получает рамки', () => {
  const p = planAnalyzers({ cams, watched: new Set(['c']), features: ALL });
  eq(p.get('c').overlay, true); eq(p.get('c').count, false);
});
t('камера с линией и зрителем — один поток на оба дела', () => {
  const p = planAnalyzers({ cams, countLines: lines, watched: new Set(['a']), features: ALL });
  eq(p.size, 1); eq([p.get('a').count, p.get('a').overlay], [true, true]);
});
t('никто не смотрит и линий нет — потоков ноль', () => eq(planAnalyzers({ cams, features: ALL }).size, 0));
t('рамок не больше лимита, даже если смотрят все камеры', () => {
  const p = planAnalyzers({ cams, watched: new Set(cams.map(c => c.id)), features: ALL, maxOverlay: 4 });
  eq([...p.values()].filter(x => x.overlay).length, 4);
});
t('подсчёт выключен у объекта — линия не запускает поток', () => {
  eq(planAnalyzers({ cams, countLines: lines, features: { people_boxes: true } }).size, 0);
});
t('рамки выключены у объекта — зритель не запускает поток', () => {
  eq(planAnalyzers({ cams, watched: new Set(['c']), features: { visitor_count: true } }).size, 0);
});
t('профиля объекта нет (старый бридж) — ничего не запускается', () => {
  eq(planAnalyzers({ cams, countLines: lines, watched: new Set(['a']), features: null }).size, 0);
});
t('зритель камеры, которой нет в списке активных, игнорируется', () => {
  eq(planAnalyzers({ cams, watched: new Set(['zzz']), features: ALL }).size, 0);
});

const tr = (id, lastSeen, group = 'person') => ({ id, group, lastSeen, box: { x1: 0.1234567, y1: 0.2, x2: 0.3, y2: 0.9 } });
t('в панель уходят только люди, обновлённые на этом кадре', () => {
  const p = tracksPayload('a', [tr(1, 100), tr(2, 50), tr(3, 100, 'bag')], 100);
  eq(p.tracks.map(x => x.id), [1]);
});
t('координаты округлены — сообщение короче', () => eq(tracksPayload('a', [tr(1, 1)], 1).tracks[0].b, [0.123, 0.2, 0.3, 0.9]));
t('ограничитель: не чаще раза в интервал на камеру', () => {
  const th = new Throttle(200);
  eq([th.ready('a', 0), th.ready('a', 100), th.ready('b', 100), th.ready('a', 250)], [true, false, true, true]);
});
t('кто что смотрит — из присутствия в канале', () => {
  const st = { v1: [{ camera_id: 'a' }], v2: [{ camera_id: 'a' }, { camera_id: 'b' }], bridge: [{ role: 'bridge' }] };
  eq([...watchedFromPresence(st)].sort(), ['a', 'b']);
});
t('мусор в присутствии не роняет бридж', () => eq(watchedFromPresence({ x: [null, { camera_id: 5 }] }).size, 0));


const SH = [{ id: 'r1', camera_id: 'b', kind: 'shelf', points: [[0, 0], [1, 0], [1, 1]] }, { id: 'r2', camera_id: 'c', kind: 'cash_drawer', points: [[0, 0], [1, 0], [1, 1]] }];
t('камера с полкой и включённой кражей — поток с позами', () => {
  const p = planAnalyzers({ cams, regions: SH, features: { theft_shelf: true } });
  eq([...p.keys()], ['b']); eq([p.get('b').theft, p.get('b').shelves.length], [true, 1]);
});
t('кража с полки выключена у объекта — полка не запускает поток', () => {
  eq(planAnalyzers({ cams, regions: SH, features: { visitor_count: true } }).size, 0);
});
t('зона кассы не включает режим полок', () => {
  eq(planAnalyzers({ cams, regions: SH, features: { theft_shelf: true } }).has('c'), false);
});


const CZ = [{ id: 'k1', camera_id: 'd', kind: 'cash_drawer', points: [[0, 0], [1, 0], [1, 1]] }, { id: 'k2', camera_id: 'e', kind: 'cash_customer', points: [[0, 0], [1, 0], [1, 1]] }];
t('камера с денежным ящиком и включённой кассой — поток с позами', () => {
  const p = planAnalyzers({ cams, regions: CZ, features: { theft_cashier: true } });
  eq([...p.keys()], ['d']); eq(p.get('d').cash, true);
});
t('только зона покупателя без ящика — потока нет', () => {
  eq(planAnalyzers({ cams, regions: CZ, features: { theft_cashier: true } }).has('e'), false);
});
t('касса выключена у объекта — ящик не запускает поток', () => {
  eq(planAnalyzers({ cams, regions: CZ, features: { theft_shelf: true } }).size, 0);
});


t('камера проверки лиц + чёрный список + записи в списке — поток лиц', () => {
  const p = planAnalyzers({ cams, features: { blacklist: true }, faceCameras: new Set(['f']), blacklistSize: 3 });
  eq(p.get('f')?.faces, true);
});
t('список пуст — лица не ищем, процессор не тратим', () => {
  eq(planAnalyzers({ cams, features: { blacklist: true }, faceCameras: new Set(['f']), blacklistSize: 0 }).size, 0);
});
t('чёрный список выключен у объекта — камера с отметкой не ищет лица', () => {
  eq(planAnalyzers({ cams, features: {}, faceCameras: new Set(['f']), blacklistSize: 3 }).size, 0);
});


const QZ = [{ id: 'z1', camera_id: 'a', kind: 'queue', points: [[0, 0], [1, 0], [1, 1]] }];
t('зона очереди + функция «очередь» → поток для подсчёта очереди', () => {
  const p = planAnalyzers({ cams, regions: QZ, features: { queue: true } });
  eq([p.get('a')?.queue, p.get('a')?.queueRegions.length], [true, 1]);
});
t('функция «очередь» выключена — зона очереди не запускает поток', () => {
  eq(planAnalyzers({ cams, regions: QZ, features: {} }).size, 0);
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
process.exit(failed ? 1 : 0);
