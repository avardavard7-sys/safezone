/**
 * Функции магазина поверх детектора людей: очередь у кассы, тепловая карта,
 * тихие часы кассы и отчёт за день. Логика без видео — проверяется отдельно.
 */
import { pointInPolygon } from './shelf.js';

const foot = b => ({ x: (b.x1 + b.x2) / 2, y: b.y2 });
const TZ_OFFSET_MS = 5 * 3600 * 1000;
const localMinutes = ms => { const d = new Date(ms + TZ_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

/** Очередь: людей в зоне очереди, сглаженно по медиане за окно. */
export class QueueWatch {
  constructor({ regions = [], windowMs = 10000, sampleMs = 60000, alertAt = 5, alertHoldMs = 120000, cooldownMs = 15 * 60000 } = {}) {
    Object.assign(this, { windowMs, sampleMs, alertAt, alertHoldMs, cooldownMs });
    this.state = new Map();
    this.setRegions(regions);
  }
  setRegions(regions) {
    this.regions = (regions || []).filter(r => r.kind === 'queue' && Array.isArray(r.points) && r.points.length >= 3)
      .map(r => ({ id: r.id, name: r.name || 'Очередь', poly: r.points.map(([x, y]) => [+x, +y]) }));
  }
  /** @returns {{ samples: [{regionId, people, at}], alerts: [{regionId, name, people, since}] }} */
  observe(people, nowMs) {
    const samples = [], alerts = [];
    for (const r of this.regions) {
      const n = people.filter(p => pointInPolygon(foot(p), r.poly)).length;
      let st = this.state.get(r.id);
      if (!st) { st = { hist: [], lastSample: -Infinity, overSince: 0, cooldownUntil: 0 }; this.state.set(r.id, st); }
      st.hist.push({ at: nowMs, n });
      st.hist = st.hist.filter(h => nowMs - h.at <= this.windowMs);
      const sorted = st.hist.map(h => h.n).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (nowMs - st.lastSample >= this.sampleMs) { samples.push({ regionId: r.id, people: median, at: nowMs }); st.lastSample = nowMs; }
      if (median >= this.alertAt) {
        if (!st.overSince) st.overSince = nowMs;
        if (nowMs - st.overSince >= this.alertHoldMs && nowMs >= st.cooldownUntil) {
          alerts.push({ regionId: r.id, name: r.name, people: median, since: st.overSince });
          st.cooldownUntil = nowMs + this.cooldownMs;
        }
      } else st.overSince = 0;
    }
    return { samples, alerts };
  }
}

/** Тепловая карта: сетка 32×18 по положению ног людей, по часам. */
export class HeatAccumulator {
  constructor({ cols = 32, rows = 18 } = {}) { this.cols = cols; this.rows = rows; this.buckets = new Map(); }
  add(cameraId, people, nowMs) {
    if (!people.length) return;
    const hour = Math.floor(nowMs / 3600000) * 3600000;
    const key = `${cameraId}|${hour}`;
    let b = this.buckets.get(key);
    if (!b) { b = { cameraId, hour, cells: new Array(this.cols * this.rows).fill(0), samples: 0 }; this.buckets.set(key, b); }
    b.samples++;
    for (const p of people) {
      const f = foot(p);
      const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(f.x * this.cols)));
      const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(f.y * this.rows)));
      b.cells[cy * this.cols + cx]++;
    }
  }
  /** Забрать накопленное для записи в базу и начать заново. */
  drain() { const out = [...this.buckets.values()]; this.buckets.clear(); return out; }
}

/** Тихие часы: 09:00–09:30 и т. п. по времени Алматы; промежуток может переходить через полночь. */
export function inQuietHours(ranges, nowMs) {
  const t = localMinutes(nowMs);
  return (ranges || []).some(({ from, to }) => {
    const a = toMin(from), b = toMin(to);
    return a <= b ? t >= a && t < b : t >= a || t < b;
  });
}

/** Когда отправлять отчёт: после закрытия рабочего дня, один раз за день. */
export function reportDue({ nowMs, dayStart, workStart = '00:00', workEnd = '22:00', lastSentFor = null }) {
  if (!dayStart) return false;
  const startMs = Date.parse(dayStart);
  let span = (toMin(workEnd) - toMin(workStart) + 1440) % 1440;
  if (span === 0) span = 1440;
  const endMs = startMs + span * 60000;
  return nowMs >= endMs && lastSentFor !== dayStart;
}

const TYPE_RU = {
  fight: 'драка', fall: 'падение', fire: 'огонь и дым', smoking: 'курение', weapon: 'оружие', crowd: 'скопление',
  concealment: 'сокрытие товара', cash_suspicious: 'касса', blacklist_match: 'чёрный список', queue_long: 'очередь',
  abandoned_object: 'брошенная вещь', loitering: 'топтание', theft: 'кража', suspicious: 'подозрительное', access: 'доступ',
};

export function formatReport(r) {
  if (!r) return null;
  const lines = [`📊 <b>Итоги дня — ${r.object || 'объект'}</b>`, ''];
  lines.push(`👥 Посетителей: <b>${r.entries ?? 0}</b>`);
  if (r.peak?.count) lines.push(`📈 Пик: ${r.peak.count} чел. в ${r.peak.at}`);
  if (r.avg_dwell_min != null) lines.push(`⏱ В среднем в зале: ${r.avg_dwell_min} мин`);
  if (r.sales) lines.push(`🧾 Чеков: ${r.sales}${r.entries ? ` · конверсия ${Math.round((r.sales / r.entries) * 100)}%` : ''}`);
  if (r.queue_max != null) lines.push(`🧍 Самая длинная очередь: ${r.queue_max} чел.`);
  const inc = r.incidents || [];
  lines.push('');
  if (!inc.length) lines.push('✅ Тревог не было');
  else {
    const total = inc.reduce((s, i) => s + i.n, 0);
    lines.push(`⚠️ Тревог: <b>${total}</b>`);
    for (const i of inc) {
      const checked = i.confirmed || i.false ? ` (подтверждено ${i.confirmed}, ложных ${i.false})` : '';
      lines.push(`  • ${TYPE_RU[i.type] || i.type}: ${i.n}${checked}`);
    }
  }
  return lines.join('\n');
}

/**
 * Возврат по чеку без покупателя у кассы.
 * 'wait' — ещё рано судить; 'unknown' — камера в это время не смотрела, не обвиняем;
 * 'ok' — покупатель был; 'alert' — камера видела кассу, а покупателя не было.
 */
export function judgeReturn(atMs, nowMs, histories, { beforeMs = 60000, afterMs = 30000, minSamples = 20 } = {}) {
  if (nowMs < atMs + afterMs) return 'wait';
  const from = atMs - beforeMs, to = atMs + afterMs;
  const covered = (histories || []).map(h => h.filter(x => x.t >= from && x.t <= to)).filter(w => w.length >= minSamples);
  if (!covered.length) return 'unknown';
  return covered.some(w => w.some(x => x.present)) ? 'ok' : 'alert';
}
