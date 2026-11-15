// Тесты доступа бриджа: пауза, срок, отзыв, лимит камер, работа без связи.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AccessGate, classifyError, loadAccess, saveAccess, DEFAULT_GRACE_MS } from './access.js';

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); } };
const HOUR = 3600e3, DAY = 24 * HOUR;
let t = Date.parse('2026-11-10T08:00:00Z');
const clock = () => t;
const net = new Error('TypeError: fetch failed'), denied = new Error('heartbeat не прошёл: бридж не найден');

console.log('\nОбычная работа');
{
  const g = new AccessGate({ now: clock });
  g.onHeartbeat({ settings: {} });
  ok('старое облако без блока доступа → работает как раньше', g.status().allowed && g.status().state === 'active');
  g.onHeartbeat({ access: { state: 'active', until: null, max_cameras: null } });
  ok('доступ активен', g.status().allowed && g.status().maxCameras === null);
}

console.log('\nПауза и возобновление');
{
  const g = new AccessGate({ now: clock });
  g.onHeartbeat({ access: { state: 'paused', message: 'Оплата не поступила' } });
  const s = g.status();
  ok('админ поставил паузу → анализ остановлен', !s.allowed && s.state === 'paused');
  ok('клиент видит сообщение админа', s.message === 'Оплата не поступила', s.message);
  g.onHeartbeat({ access: { state: 'active' } });
  ok('админ возобновил → работает без переустановки', g.status().allowed);
  g.onHeartbeat({ access: { state: 'paused' } });
  ok('пауза без текста → стандартное сообщение', g.status().message.includes('приостановлен'));
}

console.log('\nСрок доступа');
{
  t = Date.parse('2026-11-10T08:00:00Z');
  const g = new AccessGate({ now: clock });
  g.onHeartbeat({ access: { state: 'active', until: '2026-11-12T00:00:00Z' } });
  ok('срок ещё не вышел → работает', g.status().allowed);
  t = Date.parse('2026-11-12T00:00:01Z');
  ok('срок вышел без связи с облаком → всё равно останавливается', !g.status().allowed && g.status().state === 'expired');
  g.onHeartbeat({ access: { state: 'active', until: '2026-12-12T00:00:00Z' } });
  ok('админ продлил → работает', g.status().allowed);
  t = Date.parse('2026-11-01T00:00:00Z');
  g.access.until = Date.parse('2026-11-12T00:00:00Z');
  ok('часы перевели назад → срок считается от последней связи', g.status().state === 'expired', g.status().state);
}

console.log('\nНет интернета');
{
  t = Date.parse('2026-11-10T08:00:00Z');
  const g = new AccessGate({ now: clock });
  g.onHeartbeat({ access: { state: 'active' } });
  for (let i = 0; i < 50; i++) g.onHeartbeatError(net);
  t += 2 * HOUR;
  ok('связи нет 2 часа → работает на сохранённых настройках', g.status().allowed && g.status().state === 'offline_grace');
  t += 2 * DAY + 20 * HOUR;
  ok('связи нет почти 3 дня → всё ещё работает', g.status().allowed);
  t += 6 * HOUR;
  ok('связи нет больше 3 дней → останавливается', !g.status().allowed && g.status().state === 'offline_stopped');
  g.onHeartbeat({ access: { state: 'active' } });
  ok('связь вернулась → сам продолжает', g.status().allowed && g.status().state === 'active');
  const fresh = new AccessGate({ now: clock });
  ok('первый запуск без связи → даёт время на подключение', fresh.status().allowed);
  ok('запас по умолчанию ровно 3 дня', DEFAULT_GRACE_MS === 3 * DAY);
}

console.log('\nОтзыв доступа');
{
  t = Date.parse('2026-11-10T08:00:00Z');
  const g = new AccessGate({ now: clock });
  g.onHeartbeat({ access: { state: 'active' } });
  g.onHeartbeatError(denied); g.onHeartbeatError(denied);
  ok('два отказа подряд → клиента ещё не отключаем', g.status().allowed);
  g.onHeartbeatError(net); g.onHeartbeatError(denied); g.onHeartbeatError(denied);
  ok('обрыв связи между отказами сбрасывает счёт', g.status().allowed);
  g.onHeartbeatError(denied);
  ok('три отказа подряд → бридж удалён в панели, доступ отозван', !g.status().allowed && g.status().state === 'revoked');
  ok('ошибки разбираются верно', classifyError(net) === 'network' && classifyError(denied) === 'denied' && classifyError(new Error('что-то странное')) === 'network' && classifyError(new Error('ETIMEDOUT')) === 'network');
  const r = new AccessGate({ now: clock }); r.onHeartbeat({ access: { state: 'revoked' } });
  ok('облако прямо сообщило об отзыве', r.status().state === 'revoked');
}

console.log('\nЛимит камер');
{
  const cams = Array.from({ length: 10 }, (_, i) => ({ id: i }));
  const g = new AccessGate({ now: clock });
  g.onHeartbeat({ access: { state: 'active', max_cameras: 4 } });
  ok('лимит 4 из 10 → обрабатываются первые 4', g.limitCameras(cams).length === 4 && g.limitCameras(cams)[3].id === 3);
  g.onHeartbeat({ access: { state: 'active', max_cameras: null } });
  ok('без лимита → все камеры', g.limitCameras(cams).length === 10);
  g.onHeartbeat({ access: { state: 'active', max_cameras: 'мусор' } });
  ok('битое значение лимита не режет камеры', g.limitCameras(cams).length === 10);
  g.onHeartbeat({ access: { state: 'active', max_cameras: 50 } });
  ok('лимит больше числа камер ничего не меняет', g.limitCameras(cams).length === 10);
}

console.log('\nПерезагрузка компьютера');
{
  t = Date.parse('2026-11-10T08:00:00Z');
  const file = join(mkdtempSync(join(tmpdir(), 'sz-access-')), 'access.json');
  const g = new AccessGate({ now: clock });
  g.onHeartbeat({ access: { state: 'active', until: '2026-11-20T00:00:00Z', max_cameras: 8 } });
  ok('состояние сохраняется на диск', saveAccess(file, g) === true);
  t += 2 * DAY;
  const g2 = new AccessGate({ now: clock, ...loadAccess(file) });
  ok('после перезагрузки отсчёт без связи не обнуляется', g2.status().state === 'offline_grace' && g2.status().offlineMs === 2 * DAY);
  ok('срок и лимит камер восстановлены', g2.status().maxCameras === 8 && g2.status().until === Date.parse('2026-11-20T00:00:00Z'));
  t += 2 * DAY;
  ok('перезагрузками запас в 3 дня не продлить', !g2.status().allowed && new AccessGate({ now: clock, ...loadAccess(file) }).status().state === 'offline_stopped');
  ok('битый или отсутствующий файл не ломает запуск', loadAccess('/нет/такого/файла').lastOkAt === null);
}

console.log(`\n  Пройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);
