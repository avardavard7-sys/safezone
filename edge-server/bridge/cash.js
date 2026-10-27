/**
 * Касса — локально по скелету, без облака и без кассовой системы.
 *
 *  1. «Касса без покупателя»: кисть в денежном ящике дольше aloneMs, а в зоне
 *     покупателя никого нет уже customerGraceMs. Работает при любом угле камеры,
 *     в том числе строго сверху. Без размеченной зоны покупателя выключено:
 *     не зная, где стоит покупатель, нельзя утверждать, что его нет.
 *
 *  2. «Из ящика к карману»: кисть была в ящике и в течение windowMs оказалась
 *     у кармана кассира и задержалась. Только если камера видит бёдра: сверху
 *     руки, лежащие вдоль тела, неотличимы от рук у карманов.
 *
 * Инкассация, размен, выдача сдачи по видео неотличимы от кражи без данных
 * кассы — поэтому это подозрение для проверки человеком.
 */
import { pointInPolygon, bodyFrame, concealSpot } from './shelf.js';
import { inQuietHours } from './shopkit.js';

const L_WR = 9, R_WR = 10;
const footOf = b => ({ x: (b.x1 + b.x2) / 2, y: b.y2 });
const centerOf = b => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });

export class CashWatch {
  constructor({
    regions = [], windowMs = 3000, dwellMs = 500, aloneMs = 1500,
    customerGraceMs = 5000, cooldownMs = 120000, minConf = 0.35, wristConf = 0.5,
  } = {}) {
    Object.assign(this, { windowMs, dwellMs, aloneMs, customerGraceMs, cooldownMs, minConf, wristConf });
    this.state = new Map();
    this.customerSeenAt = -Infinity;
    this.cooldownUntil = 0;
    this.quiet = [];
    this.presence = [];
    this.setRegions(regions);
  }

  setRegions(regions) {
    const poly = r => r.points.map(([x, y]) => [+x, +y]);
    const ok = r => Array.isArray(r.points) && r.points.length >= 3;
    this.drawers = (regions || []).filter(r => r.kind === 'cash_drawer' && ok(r)).map(r => ({ id: r.id, name: r.name || 'Касса', poly: poly(r) }));
    this.customers = (regions || []).filter(r => r.kind === 'cash_customer' && ok(r)).map(r => ({ id: r.id, poly: poly(r) }));
  }

  /** Тихие часы: инкассация и размен в эти промежутки не вызывают тревогу «без покупателя». */
  setQuiet(ranges) { this.quiet = Array.isArray(ranges) ? ranges : []; }

  #inCustomer(p) { return this.customers.some(c => pointInPolygon(p, c.poly)); }
  #drawerAt(p) { return this.drawers.find(d => pointInPolygon(p, d.poly)) || null; }

  observe(tracks, nowMs, frame = null) {
    const alerts = [];
    if (!this.drawers.length) return alerts;
    const fresh = tracks.filter(tr => (!tr.group || tr.group === 'person') && tr.lastSeen === nowMs);

    // покупатель — человек, стоящий в зоне покупателя (по ногам или центру рамки)
    for (const tr of fresh) {
      if (this.#inCustomer(footOf(tr.box)) || this.#inCustomer(centerOf(tr.box))) this.customerSeenAt = nowMs;
    }
    // история присутствия покупателя — для проверки возвратов из кассовой системы
    if (this.customers.length && (!this.presence.length || nowMs - this.presence[this.presence.length - 1].t >= 1000)) {
      this.presence.push({ t: nowMs, present: this.customerSeenAt === nowMs });
      while (this.presence.length && nowMs - this.presence[0].t > 15 * 60000) this.presence.shift();
    }
    const noCustomer = this.customers.length > 0 && nowMs - this.customerSeenAt > this.customerGraceMs && !inQuietHours(this.quiet, nowMs);

    for (const tr of fresh) {
      const k = tr.kpts;
      if (!k || k.length < 17) continue;
      let st = this.state.get(tr.id);
      if (!st) { st = { hands: {}, at: nowMs }; this.state.set(tr.id, st); }
      st.at = nowMs;
      const f = bodyFrame(k, this.minConf, this.wristConf);

      for (const [hand, idx] of [['left', L_WR], ['right', R_WR]]) {
        const w = k[idx] && k[idx].c >= this.wristConf ? k[idx] : null;
        const h = st.hands[hand] || (st.hands[hand] = { since: 0, touch: null, nearSince: 0 });
        if (!w) { h.since = 0; continue; }

        const drawer = this.#drawerAt(w);
        if (drawer) {
          if (!h.since) h.since = nowMs;
          h.touch = { at: nowMs, drawer, point: { x: w.x, y: w.y }, box: { ...tr.box }, frame };
          h.nearSince = 0;
          if (noCustomer && nowMs - h.since >= this.aloneMs && nowMs >= this.cooldownUntil) {
            alerts.push({ kind: 'no_customer', trackId: tr.id, hand, drawer, at: nowMs, point: { x: w.x, y: w.y }, box: { ...tr.box } });
            this.cooldownUntil = nowMs + this.cooldownMs;
          }
          continue;
        }
        h.since = 0;

        // правило 2 — только если скелет видит бёдра
        const recent = h.touch && nowMs - h.touch.at <= this.windowMs;
        const spot = f && recent && !this.#inCustomer(w) ? concealSpot(w, f) : null;
        if (!spot) { h.nearSince = 0; continue; }
        if (!h.nearSince) { h.nearSince = nowMs; continue; }
        if (nowMs - h.nearSince < this.dwellMs || nowMs < this.cooldownUntil) continue;
        alerts.push({
          kind: 'pocket', trackId: tr.id, hand, drawer: h.touch.drawer,
          reach: { at: h.touch.at, point: h.touch.point, box: h.touch.box, frame: h.touch.frame },
          conceal: { at: nowMs, point: { x: w.x, y: w.y }, box: { ...tr.box } },
        });
        this.cooldownUntil = nowMs + this.cooldownMs;
        h.touch = null; h.nearSince = 0;
      }
    }
    for (const [id, st] of this.state) if (nowMs - st.at > 30_000) this.state.delete(id);
    return alerts;
  }
}
