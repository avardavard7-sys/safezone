import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync } from 'fs';
import os from 'os';

const DEFAULT_STATE = './state.json';

export function statePath() {
  return process.env.STATE_FILE || DEFAULT_STATE;
}

export function loadState(file = statePath()) {
  try {
    if (!existsSync(file)) return null;
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return s && s.token ? s : null;
  } catch {
    return null;
  }
}

export function saveState(state, file = statePath()) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, file);
  return state;
}

export function platformString() {
  return `${os.type()} ${os.release()} · node ${process.version} · ${os.cpus().length} ядер`;
}

function rpcError(error, data, fallback) {
  if (error) return new Error(error.message || fallback);
  if (!data || data.ok === false) return new Error(data?.error || fallback);
  return null;
}

export async function pair(sb, { code, version, platform }) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) throw new Error('код привязки пустой');
  const { data, error } = await sb.rpc('bridge_pair', { code: clean, ver: version, plat: platform });
  const err = rpcError(error, data, 'привязка не удалась');
  if (err) throw err;
  return data;
}

export async function heartbeat(sb, token, stats = {}) {
  const { data, error } = await sb.rpc('bridge_heartbeat', { bridge_token: token, s: stats });
  const err = rpcError(error, data, 'heartbeat не прошёл');
  if (err) throw err;
  return data;
}

export async function signIn(sb, email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`вход сервис-аккаунта: ${error.message}`);
}

/**
 * Приводит бридж в рабочее состояние.
 *
 * Первый запуск: есть код -> bridge_pair -> сохраняем токен и учётку на диск.
 * Последующие:   читаем state.json -> вход по сохранённой учётке -> heartbeat.
 *
 * Повторная привязка того же бриджа возвращает password: null (учётка одна на
 * бридж и переиспользуется). Пароль берётся из сохранённого состояния; если
 * состояние потеряно - восстановить его нельзя, нужен новый бридж в панели.
 */
export async function ensureSession({ sb, version, platform, pairingCode, log = () => {} }) {
  let state = loadState();

  if (!state) {
    if (!pairingCode) {
      throw new Error(
        'бридж не привязан. Открой панель -> Бридж -> «Добавить бридж», ' +
        'скопируй код из 8 символов и впиши его в .env как PAIRING_CODE'
      );
    }
    log('Привязка по коду...');
    const res = await pair(sb, { code: pairingCode, version, platform });
    if (!res.account?.password) {
      throw new Error(
        'этот код уже использовался, а пароль сервис-аккаунта выдаётся только при первой привязке. ' +
        'Удали бридж в панели и создай новый код'
      );
    }
    state = saveState({
      bridge_id: res.bridge_id,
      token: res.token,
      mall_id: res.mall_id,
      mall_name: res.mall_name || null,
      email: res.account.email,
      password: res.account.password,
      paired_at: new Date().toISOString(),
    });
    log(`Привязан к объекту «${state.mall_name || state.mall_id}». Состояние сохранено в ${statePath()}`);
    await signIn(sb, state.email, state.password);
    return { state, payload: res, fresh: true };
  }

  await signIn(sb, state.email, state.password);
  const payload = await heartbeat(sb, state.token, { boot: true, platform });
  if (payload.mall_id && payload.mall_id !== state.mall_id) {
    state = saveState({ ...state, mall_id: payload.mall_id });
  }
  log(`Восстановлена привязка к объекту ${state.mall_name || state.mall_id}`);
  return { state, payload, fresh: false };
}
