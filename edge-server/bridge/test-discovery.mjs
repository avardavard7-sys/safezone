import { isPrivatePrefix, parseSubnets, planTargets, channelOf, pickStreams } from './discovery-plan.js';

let passed = 0, failed = 0; const out = [];
const t = (n, f) => { try { f(); passed++; out.push(`  ok   ${n}`); } catch (e) { failed++; out.push(`  FAIL ${n}\n         ${e.message}`); } };
const eq = (a, b, w = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${w} ожидалось ${JSON.stringify(b)}, пришло ${JSON.stringify(a)}`); };

console.log('\n=== Автопоиск камер ===\n');

t('частные сети разрешены, публичные — нет', () => {
  eq(['192.168.1', '10.0.5', '172.20.3', '172.32.1', '8.8.8', '95.56.12'].map(isPrivatePrefix), [true, true, true, false, false, false]);
});
t('подсети из строки: запятые, маска, дубли, мусор', () => {
  eq(parseSubnets('192.168.1, 192.168.2.0/24;192.168.1 abc 8.8.8'), ['192.168.1', '192.168.2']);
});
t('не больше четырёх подсетей за раз', () => eq(parseSubnets('10.0.1 10.0.2 10.0.3 10.0.4 10.0.5').length, 4));

t('на VPS без сети объекта — не ищем нигде (не стучимся к соседям по хостингу)', () => {
  eq(planTargets({ serverMode: true, local: ['95.56.12'] }), { targets: [], source: null });
});
t('на VPS берём сеть объекта из панели', () => {
  eq(planTargets({ serverMode: true, site: ['192.168.1'], local: ['95.56.12'] }).targets, ['192.168.1']);
});
t('явно указанная подсеть важнее сети объекта', () => {
  eq(planTargets({ asked: '192.168.5', site: ['192.168.1'] }).targets, ['192.168.5']);
});
t('публичная подсеть вручную — отбрасывается', () => {
  eq(planTargets({ asked: '95.56.12', serverMode: true }).targets, []);
});
t('бридж на компьютере объекта ищет по своим частным сетям', () => {
  eq(planTargets({ local: ['192.168.10', '95.56.12'] }).targets, ['192.168.10']);
});

t('канал у Dahua и Imou', () => eq(channelOf('/cam/realmonitor?channel=3&subtype=1'), 3));
t('канал у Hikvision: 301 и 302 — это третий канал', () => eq([channelOf('/Streaming/Channels/301'), channelOf('/Streaming/Channels/302')], [3, 3]));
t('одиночная камера без канала', () => eq(channelOf('/live/main'), null));

const NVR = (host, n, cred = 0) => ({
  host, cred, info: { manufacturer: 'Dahua', model: 'NVR4108' },
  profiles: Array.from({ length: n }, (_, i) => i + 1).flatMap(ch => [
    { name: `main${ch}`, resolution: '2560x1440', encoding: 'H265', parsed: { ip: host, port: 554, path: `/cam/realmonitor?channel=${ch}&subtype=0` } },
    { name: `sub${ch}`, resolution: '704x576', encoding: 'H264', parsed: { ip: host, port: 554, path: `/cam/realmonitor?channel=${ch}&subtype=1` } },
  ]),
});

t('регистратор на 8 каналов → ровно 8 камер, а не 16 потоков', () => eq(pickStreams([NVR('192.168.1.108', 8)]).length, 8));
t('из основного H.265 и дополнительного H.264 берётся H.264 — его покажет браузер', () => {
  const c = pickStreams([NVR('192.168.1.108', 1)])[0];
  eq([c.encoding, c.path.includes('subtype=1'), c.browser_ok], ['H264', true, true]);
});
t('если оба потока H.264 — берётся крупный', () => {
  const d = { host: '192.168.1.20', info: {}, profiles: [
    { name: 'a', resolution: '1920x1080', encoding: 'H264', parsed: { ip: '192.168.1.20', port: 554, path: '/a' } },
    { name: 'b', resolution: '640x360', encoding: 'H264', parsed: { ip: '192.168.1.20', port: 554, path: '/b' } }] };
  eq(pickStreams([d])[0].resolution, '1920x1080');
});
t('только H.265 — камера добавляется, но помечена: браузер может не показать', () => {
  const d = { host: '192.168.1.30', info: {}, profiles: [{ name: 'm', resolution: '2560x1440', encoding: 'H265', parsed: { ip: '192.168.1.30', port: 554, path: '/m' } }] };
  eq(pickStreams([d])[0].browser_ok, false);
});
t('два регистратора с разными паролями → все каналы обоих, каждый со своим паролем', () => {
  const list = pickStreams([NVR('192.168.1.108', 4, 0), NVR('192.168.1.109', 8, 1)]);
  eq([list.length, list.filter(c => c.cred === 1).length, list[0].name], [12, 8, 'Dahua NVR4108 · канал 1']);
});
t('порядок: по адресу, потом по каналу', () => {
  const list = pickStreams([NVR('192.168.1.109', 2), NVR('192.168.1.108', 2)]);
  eq(list.map(c => `${c.ip.split('.').pop()}:${c.channel}`), ['108:1', '108:2', '109:1', '109:2']);
});
t('одиночная камера получает имя по адресу', () => {
  const d = { host: '192.168.1.20', info: { manufacturer: 'Imou', model: 'IPC-K2EP' }, profiles: [{ name: 'x', resolution: '1920x1080', encoding: 'H264', parsed: { ip: '192.168.1.20', port: 554, path: '/cam/realmonitor?channel=1&subtype=0' } }] };
  eq(pickStreams([d])[0].name, 'Imou IPC-K2EP · 192.168.1.20');
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
process.exit(failed ? 1 : 0);
