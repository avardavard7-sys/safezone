// Поддельный бридж для проверки приложения без облака и камер.
import http from 'http';
import { existsSync, writeFileSync } from 'fs';
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const { PAIRING_CODE = '', STATE_FILE, API_PORT = '8099', FAKE_ACCESS = 'active' } = process.env;
if (!existsSync(STATE_FILE)) {
  if (PAIRING_CODE !== 'TEST1234') {
    log(''); log('✗ Бридж не привязан к объекту.'); log(`  ${PAIRING_CODE ? 'код не найден или уже использован' : 'нужен код привязки'}`); log('');
    process.exit(1);
  }
  writeFileSync(STATE_FILE, JSON.stringify({ token: 't'.repeat(64) }));
  log('Привязан к объекту «Магазин на Абая»');
}
const access = { active: { allowed: true, state: 'active', until: Date.parse('2027-03-01T00:00:00Z'), maxCameras: 16, message: 'Доступ активен' },
  paused: { allowed: false, state: 'paused', until: null, maxCameras: null, message: 'Оплата не поступила. Обратитесь к поставщику' } }[FAKE_ACCESS];
http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ ok: true, version: '7.13.0', paired: true, cameras: FAKE_ACCESS === 'paused' ? 0 : 6, access })); }).listen(Number(API_PORT), '127.0.0.1');
log('=== SafeZone Bridge 7.13.0 — PAIRED ==='); log('Найдено камер: 6'); log(`${access.allowed ? '🔓' : '🔒'} Доступ: ${access.message}`);
setInterval(() => log('проход: 6 камер, тревог нет'), 2000);
