// Настоящий запуск бриджа: привязка по коду и повторный запуск с сохранённой привязкой.
// Платформа подменена маленьким HTTP-сервером, который отвечает как Supabase.
import http from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } };

const MALL = '11111111-1111-4111-8111-111111111111';
const payload = {
  ok: true, bridge_id: '22222222-2222-4222-8222-222222222222', token: 'tok', mall_id: MALL, mall_name: 'Тестовый объект',
  settings: {}, count_lines: [], regions: [{ id: 'd', kind: 'cash_drawer', points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] }],
  cash_quiet: [{ from: '22:00', to: '23:00' }], features: { theft: true, cash: true }, business_type: 'retail',
  report: {}, site_subnets: [], face_cameras: [],
};
const user = { id: '33333333-3333-4333-8333-333333333333', aud: 'authenticated', role: 'authenticated', email: 'b@test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    seen.push(`${req.method} ${req.url.split('?')[0]}`);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/rest/v1/rpc/bridge_pair')) return send(200, { ...payload, account: { email: 'b@test', password: 'p' } });
    if (req.url.startsWith('/rest/v1/rpc/bridge_heartbeat')) return send(200, payload);
    if (req.url.startsWith('/auth/v1/token')) return send(200, { access_token: 'a', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (req.url.startsWith('/rest/v1/rpc/')) return send(200, null);
    if (req.method === 'GET') return send(200, []);
    return send(201, []);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'sz-boot-'));
const stateFile = path.join(dir, 'state.json');

function boot(code) {
  return new Promise((resolve) => {
    const env = {
      ...process.env, SUPABASE_URL: url, SUPABASE_ANON_KEY: 'anon', PAIRING_CODE: code, STATE_FILE: stateFile,
      API_ENABLED: 'false', SZ_ON_SITE: '1', SZ_SAFE_MODE: '1', YOLO_ENABLED: 'false', TELEGRAM_BOT_TOKEN: '', PLATFORM_URL: '',
      SERVICE_KEY: '', MALL_ID: '',
    };
    const ch = spawn(process.execPath, ['index.js'], { cwd: here, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = d => {
      out += d.toString();
      if (/Восстановлена привязка|Привязан к объекту/.test(out) && !done) settle(2500);
    };
    ch.stdout.on('data', onData); ch.stderr.on('data', onData);
    let done = false;
    const finish = () => { if (done) return; done = true; try { ch.kill(); } catch {} resolve(out); };
    const settle = ms => setTimeout(finish, ms);
    ch.on('exit', code => { out += `\n[exit ${code}]`; finish(); });
    setTimeout(finish, 30000);
  });
}

console.log('\n=== Первый запуск: привязка по коду ===\n');
let out = await boot('TESTCODE');
ok(/Привязан к объекту «Тестовый объект»/.test(out), 'бридж привязался');
ok(existsSync(stateFile), 'привязка сохранена на диск');
ok(!/Бридж не привязан/.test(out), 'после привязки нет «Бридж не привязан»');
ok(!/is not defined|ReferenceError|TypeError/.test(out), 'нет ошибок «... is not defined»');
ok(!/\[exit [1-9]/.test(out), 'бридж не упал после привязки');
if (failed) console.log(out.split('\n').slice(-25).join('\n'));

console.log('\n=== Повторный запуск: та же привязка, код не нужен ===\n');
const before = failed;
out = await boot('');
ok(/Восстановлена привязка/.test(out), 'привязка восстановлена без кода');
ok(seen.includes('POST /rest/v1/rpc/bridge_heartbeat'), 'бридж сообщил платформе, что жив');
ok(!/Бридж не привязан/.test(out), 'нет «Бридж не привязан»');
ok(!/is not defined|ReferenceError|TypeError/.test(out), 'нет ошибок «... is not defined»');
ok(!/\[exit [1-9]/.test(out), 'бридж не упал');
if (failed > before) console.log(out.split('\n').slice(-25).join('\n'));

console.log('\n=== Тот же код ещё раз (клиент нажал «Привязать» повторно) ===\n');
const b2 = failed;
out = await boot('TESTCODE');
ok(/Восстановлена привязка/.test(out), 'сохранённая привязка используется, код повторно не тратится');
ok(!/Бридж не привязан|is not defined/.test(out), 'без ошибок');
if (failed > b2) console.log(out.split('\n').slice(-25).join('\n'));

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\nИтого: ${passed} прошло, ${failed} упало\n`);
process.exit(failed ? 1 : 0);
