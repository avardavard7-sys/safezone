import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let passed = 0, failed = 0;
const results = [];

function check(name, fn) {
  try {
    fn();
    passed++; results.push(`  ok   ${name}`);
  } catch (e) {
    failed++; results.push(`  FAIL ${name}\n         ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++; results.push(`  ok   ${name}`);
  } catch (e) {
    failed++; results.push(`  FAIL ${name}\n         ${e.message}`);
  }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} ожидалось ${b}, пришло ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'условие не выполнено'); }
async function throwsWith(fn, fragment) {
  try { await fn(); } catch (e) {
    if (!String(e.message).includes(fragment)) {
      throw new Error(`ожидал ошибку про "${fragment}", получил "${e.message}"`);
    }
    return;
  }
  throw new Error(`ожидал ошибку про "${fragment}", но её не было`);
}

const dir = mkdtempSync(join(tmpdir(), 'sz-pair-'));
process.env.STATE_FILE = join(dir, 'state.json');

const { loadState, saveState, pair, heartbeat, ensureSession, platformString, statePath } =
  await import('./pairing.js');

function freshState() {
  if (existsSync(statePath())) rmSync(statePath());
}

/** Мок Supabase: повторяет контракт bridge_pair / bridge_heartbeat из живой базы. */
function mockSb({ pairResult, heartbeatResult, rpcError = null, signInError = null }) {
  const calls = { rpc: [], signIn: [] };
  return {
    calls,
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      if (rpcError) return { data: null, error: { message: rpcError } };
      if (name === 'bridge_pair') return { data: pairResult, error: null };
      if (name === 'bridge_heartbeat') return { data: heartbeatResult, error: null };
      return { data: null, error: { message: 'неизвестная функция ' + name } };
    },
    auth: {
      signInWithPassword: async (creds) => {
        calls.signIn.push(creds);
        return signInError ? { error: { message: signInError } } : { error: null };
      },
    },
  };
}

const PAIR_OK = {
  ok: true,
  bridge_id: '11111111-1111-1111-1111-111111111111',
  token: 'a'.repeat(64),
  mall_id: '22222222-2222-2222-2222-222222222222',
  mall_name: 'ТРЦ Тест',
  account: { email: 'bridge-abc@bridge.safezone.local', password: 'p'.repeat(48) },
  telegram: { bot_token: '123:ABC', chat_id: '777' },
  settings: { DETECTOR: 'yolox_s' },
  zone_rules: { rules: [{ id: 'bar', rule: 'no_staff', enabled: true }] },
};

console.log('\n=== Привязка бриджа (v7.10–7.12) ===\n');

// ── состояние на диске ─────────────────────────────────────────
check('пустое состояние читается как null', () => {
  freshState();
  eq(loadState(), null);
});

check('битый JSON не роняет бридж', () => {
  writeFileSync(statePath(), '{это не json');
  eq(loadState(), null);
});

check('состояние без токена считается непривязанным', () => {
  writeFileSync(statePath(), JSON.stringify({ mall_id: 'x' }));
  eq(loadState(), null);
});

check('сохранение и чтение состояния', () => {
  freshState();
  saveState({ token: 't', mall_id: 'm', email: 'e', password: 'p' });
  eq(loadState().token, 't');
  eq(loadState().password, 'p');
});

check('после записи не остаётся временного файла', () => {
  ok(!existsSync(statePath() + '.tmp'), 'остался state.json.tmp');
});

check('состояние читаемо как обычный JSON', () => {
  const raw = JSON.parse(readFileSync(statePath(), 'utf8'));
  eq(raw.mall_id, 'm');
});

// ── bridge_pair ────────────────────────────────────────────────
await checkAsync('код приводится к верхнему регистру и обрезается', async () => {
  const sb = mockSb({ pairResult: PAIR_OK });
  await pair(sb, { code: '  abcd2345 ', version: 'v7.12', platform: 'test' });
  eq(sb.calls.rpc[0].args.code, 'ABCD2345');
});

await checkAsync('версия и платформа уходят в базу', async () => {
  const sb = mockSb({ pairResult: PAIR_OK });
  await pair(sb, { code: 'ABCD2345', version: 'v7.12', platform: 'Linux 6.1' });
  eq(sb.calls.rpc[0].args.ver, 'v7.12');
  eq(sb.calls.rpc[0].args.plat, 'Linux 6.1');
});

await checkAsync('пустой код отклоняется до обращения к базе', async () => {
  const sb = mockSb({ pairResult: PAIR_OK });
  await throwsWith(() => pair(sb, { code: '   ' }), 'пустой');
  eq(sb.calls.rpc.length, 0);
});

await checkAsync('просроченный код: показываем текст от базы', async () => {
  const sb = mockSb({ pairResult: { ok: false, error: 'код не найден или просрочен' } });
  await throwsWith(() => pair(sb, { code: 'ZZZZ9999' }), 'просрочен');
});

await checkAsync('сетевая ошибка RPC не проглатывается', async () => {
  const sb = mockSb({ rpcError: 'fetch failed' });
  await throwsWith(() => pair(sb, { code: 'ABCD2345' }), 'fetch failed');
});

// ── bridge_heartbeat ───────────────────────────────────────────
await checkAsync('heartbeat отдаёт объект, настройки и зоны', async () => {
  const sb = mockSb({ heartbeatResult: { ok: true, mall_id: 'm1', settings: {}, zone_rules: { rules: [] } } });
  const r = await heartbeat(sb, 'tok', { cycles: 3 });
  eq(r.mall_id, 'm1');
  eq(sb.calls.rpc[0].args.s.cycles, 3);
});

await checkAsync('отвязанный бридж получает внятную ошибку', async () => {
  const sb = mockSb({ heartbeatResult: { ok: false, error: 'бридж не найден, нужна повторная привязка' } });
  await throwsWith(() => heartbeat(sb, 'старый-токен'), 'повторная привязка');
});

// ── ensureSession ──────────────────────────────────────────────
await checkAsync('нет состояния и нет кода — понятная инструкция', async () => {
  freshState();
  const sb = mockSb({});
  await throwsWith(
    () => ensureSession({ sb, version: 'v7.12', platform: 'test', pairingCode: '' }),
    'PAIRING_CODE'
  );
});

await checkAsync('первая привязка: сохраняет токен, учётку и объект', async () => {
  freshState();
  const sb = mockSb({ pairResult: PAIR_OK });
  const { state, fresh } = await ensureSession({ sb, version: 'v7.12', platform: 'test', pairingCode: 'ABCD2345' });
  ok(fresh, 'должна быть первая привязка');
  eq(state.token, PAIR_OK.token);
  eq(state.mall_id, PAIR_OK.mall_id);
  eq(state.email, PAIR_OK.account.email);
  eq(state.password, PAIR_OK.account.password);
  eq(loadState().token, PAIR_OK.token, 'состояние на диске:');
});

await checkAsync('после привязки выполняется вход сервис-аккаунтом', async () => {
  freshState();
  const sb = mockSb({ pairResult: PAIR_OK });
  await ensureSession({ sb, version: 'v7.12', platform: 'test', pairingCode: 'ABCD2345' });
  eq(sb.calls.signIn.length, 1);
  eq(sb.calls.signIn[0].email, PAIR_OK.account.email);
});

await checkAsync('повторно использованный код: пароля нет — честная ошибка', async () => {
  freshState();
  const reused = { ...PAIR_OK, account: { email: PAIR_OK.account.email, password: null } };
  const sb = mockSb({ pairResult: reused });
  await throwsWith(
    () => ensureSession({ sb, version: 'v7.12', platform: 'test', pairingCode: 'ABCD2345' }),
    'создай новый код'
  );
});

await checkAsync('битая привязка не оставляет мусорного состояния', async () => {
  ok(loadState() === null, 'после неудачной привязки state.json должен отсутствовать');
});

await checkAsync('повторный старт: пароль не запрашивается заново', async () => {
  freshState();
  saveState({ token: 'tok-1', mall_id: 'm1', mall_name: 'ТРЦ', email: 'e@x', password: 'pw' });
  const sb = mockSb({ heartbeatResult: { ok: true, mall_id: 'm1', settings: {}, zone_rules: { rules: [] } } });
  const { fresh } = await ensureSession({ sb, version: 'v7.12', platform: 'test', pairingCode: 'ABCD2345' });
  ok(!fresh, 'повторный старт не должен считаться первой привязкой');
  eq(sb.calls.rpc.filter(c => c.name === 'bridge_pair').length, 0, 'bridge_pair вызовов:');
  eq(sb.calls.signIn[0].password, 'pw');
});

await checkAsync('объект переехал — состояние обновляется', async () => {
  freshState();
  saveState({ token: 'tok-1', mall_id: 'старый', email: 'e@x', password: 'pw' });
  const sb = mockSb({ heartbeatResult: { ok: true, mall_id: 'новый', settings: {}, zone_rules: { rules: [] } } });
  const { state } = await ensureSession({ sb, version: 'v7.12', platform: 'test' });
  eq(state.mall_id, 'новый');
  eq(loadState().mall_id, 'новый');
});

await checkAsync('неверный пароль учётки виден в логе, а не молча', async () => {
  freshState();
  saveState({ token: 'tok-1', mall_id: 'm1', email: 'e@x', password: 'плохой' });
  const sb = mockSb({ signInError: 'Invalid login credentials' });
  await throwsWith(() => ensureSession({ sb, version: 'v7.12', platform: 'test' }), 'сервис-аккаунт');
});

check('строка платформы заполнена', () => {
  ok(platformString().includes('node'), 'нет версии node в описании платформы');
});


// ── бюджет облака: смена потолка не должна обнулять потраченное ──
const { CloudBudget } = await import('./guard.js');

check('лимит расходуется и упирается в потолок', () => {
  const b = new CloudBudget(3);
  eq([b.take('c1').ok, b.take('c1').ok, b.take('c1').ok, b.take('c1').ok], [true, true, true, false]);
});

check('смена потолка НЕ сбрасывает счётчик за текущий час', () => {
  const b = new CloudBudget(3);
  b.take('c1'); b.take('c1');
  b.setMax(20);
  eq(b.count('c1'), 2, 'потрачено:');
  ok(b.take('c1').ok, 'после подъёма потолка вызов должен пройти');
});

check('понижение потолка ниже потраченного сразу закрывает камеру', () => {
  const b = new CloudBudget(10);
  for (let i = 0; i < 5; i++) b.take('c1');
  b.setMax(3);
  ok(!b.take('c1').ok, 'при потолке ниже потраченного вызовы должны быть закрыты');
});

check('счётчики камер независимы', () => {
  const b = new CloudBudget(2);
  b.take('c1'); b.take('c1');
  ok(!b.take('c1').ok, 'первая камера исчерпана');
  ok(b.take('c2').ok, 'вторая камера не должна страдать');
});

check('через час счётчик обнуляется сам', () => {
  const b = new CloudBudget(2);
  const t0 = Date.now();
  b.take('c1', t0); b.take('c1', t0);
  ok(!b.take('c1', t0).ok, 'в пределах часа лимит держится');
  ok(b.take('c1', t0 + 3600001).ok, 'после часа окно должно открыться');
});


// ── разбор подсети: баг, из-за которого развёртка шла по 192.168.10.8.1-254 ──
const { normalizeSubnet, localSubnets } = await import('./onvif.js');

check('полный IP камеры сводится к префиксу /24', () => {
  eq(normalizeSubnet('192.168.10.8'), '192.168.10');
});
check('запись с маской принимается', () => {
  eq(normalizeSubnet('192.168.10.0/24'), '192.168.10');
});
check('готовый префикс не портится', () => {
  eq(normalizeSubnet('192.168.10'), '192.168.10');
});
check('пробелы по краям не мешают', () => {
  eq(normalizeSubnet('  10.18.3.42  '), '10.18.3');
});
check('мусор отклоняется, а не даёт кривой адрес', () => {
  eq([normalizeSubnet('192.168'), normalizeSubnet('abc'), normalizeSubnet(''),
      normalizeSubnet(null), normalizeSubnet('999.1.1.1')], [null, null, null, null, null]);
});
check('свои подсети находятся, сети докера отсеяны', () => {
  const nets = localSubnets();
  ok(Array.isArray(nets), 'должен вернуться массив');
  ok(!nets.some(n => n.startsWith('172.17.') || n.startsWith('172.18.')), 'докер должен отсеиваться');
  ok(nets.every(n => n.split('.').length === 3), 'ровно три октета');
});

console.log(results.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
