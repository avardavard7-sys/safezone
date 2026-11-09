// access.js — доступ бриджа: пауза, срок, отзыв, лимит камер и запас работы без связи.
// Решение принимает облако: бридж только исполняет то, что пришло в ответе heartbeat.

import { readFileSync, writeFileSync, renameSync } from 'fs';

export const DEFAULT_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
const DENIED_AFTER = 3;

const DENIED_RE = /не найден|not found|отозван|revoked|недейств|invalid|unauthor|forbidden|permission|\b401\b|\b403\b|jwt/i;
const NETWORK_RE = /fetch failed|enotfound|econn|etimedout|timeout|network|eai_again|socket|aborted|\b50[234]\b/i;

/** Отказ облака (бридж удалён, токен не принят) или просто нет связи. Непонятное считаем обрывом связи. */
export function classifyError(err) {
  const msg = String(err?.message || err || '');
  if (NETWORK_RE.test(msg)) return 'network';
  if (DENIED_RE.test(msg)) return 'denied';
  return 'network';
}

const MESSAGES = {
  active: 'Доступ активен',
  offline_grace: 'Нет связи с облаком, работаю на сохранённых настройках',
  paused: 'Доступ приостановлен. Обратитесь к поставщику',
  expired: 'Срок доступа истёк. Обратитесь к поставщику',
  revoked: 'Доступ отозван. Обратитесь к поставщику',
  offline_stopped: 'Нет связи с облаком слишком долго. Проверьте интернет',
};

export class AccessGate {
  constructor({ graceMs = DEFAULT_GRACE_MS, now = () => Date.now(), lastOkAt = null, access = null } = {}) {
    this.graceMs = graceMs;
    this.now = now;
    this.lastOkAt = lastOkAt;
    this.access = access;
    this.deniedStreak = 0;
    this.startedAt = now();
  }

  /** Успешная отметка. Блока access нет — облако старое, значит доступ активен. */
  onHeartbeat(payload) {
    const a = payload && typeof payload.access === 'object' ? payload.access : null;
    this.access = a ? {
      state: ['active', 'paused', 'revoked'].includes(a.state) ? a.state : 'active',
      until: a.until ? new Date(a.until).getTime() || null : null,
      maxCameras: Number.isFinite(Number(a.max_cameras)) && a.max_cameras !== null && a.max_cameras !== '' ? Math.max(0, Number(a.max_cameras)) : null,
      message: a.message ? String(a.message).slice(0, 300) : null,
    } : { state: 'active', until: null, maxCameras: null, message: null };
    this.lastOkAt = this.now();
    this.deniedStreak = 0;
  }

  onHeartbeatError(err) {
    if (classifyError(err) === 'denied') this.deniedStreak++;
    else this.deniedStreak = 0;
  }

  status() {
    // часы перевели назад — считаем от последней успешной отметки, а не от «нового» времени
    const now = Math.max(this.now(), this.lastOkAt || 0);
    const a = this.access || { state: 'active', until: null, maxCameras: null, message: null };
    const base = { until: a.until, maxCameras: a.maxCameras };
    const out = (state, allowed) => ({ allowed, state, message: (!allowed && a.message) || MESSAGES[state], ...base });

    if (this.deniedStreak >= DENIED_AFTER || a.state === 'revoked') return out('revoked', false);
    if (a.state === 'paused') return out('paused', false);
    if (a.until && now >= a.until) return out('expired', false);

    const since = this.lastOkAt ?? this.startedAt;
    const offlineMs = now - since;
    const online = this.lastOkAt !== null && offlineMs < 5 * 60 * 1000;
    if (online) return out('active', true);
    if (offlineMs <= this.graceMs) return { ...out('offline_grace', true), offlineMs };
    return { ...out('offline_stopped', false), offlineMs };
  }

  /** Обрезает список камер по лимиту доступа. Без лимита возвращает как есть. */
  limitCameras(cams) {
    const max = this.access?.maxCameras;
    if (max === null || max === undefined || !Array.isArray(cams) || cams.length <= max) return cams;
    return cams.slice(0, max);
  }

  snapshot() {
    return { lastOkAt: this.lastOkAt, access: this.access };
  }
}

export function loadAccess(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return { lastOkAt: Number.isFinite(s.lastOkAt) ? s.lastOkAt : null, access: s.access && typeof s.access === 'object' ? s.access : null };
  } catch { return { lastOkAt: null, access: null }; }
}

export function saveAccess(file, gate) {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(gate.snapshot()));
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}
