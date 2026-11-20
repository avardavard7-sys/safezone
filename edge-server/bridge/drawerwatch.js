// Денежный ящик: открыт или закрыт — по виду самой зоны ящика, а не по точкам руки.
// Зона сравнивается с эталоном «закрыт» по структуре блоков; руки над ящиком не считаются.
import sharp from 'sharp';
import { decodeGray, blockStats, blockChanged, handSpot, WB, HB, B } from './shelfchange.js';
import { inQuietHours } from './shopkit.js';

const N = WB * HB, BB = B * B, ASPECT = HB / WB;
const ARMS = [[5, 7], [7, 9], [6, 8], [8, 10]];
const L_WR = 9, R_WR = 10;

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function armDist(k, a, b, x, y) {
  const A = k[a], P = k[b];
  if (!A || !P || A.c < 0.3 || P.c < 0.3) return 9;
  const dx = P.x - A.x, dy = P.y - A.y;
  let t = ((x - A.x) * dx + (y - A.y) * dy) / (dx * dx + dy * dy + 1e-9);
  t = Math.max(0, Math.min(1.35, t));
  return Math.hypot(x - A.x - t * dx, (y - A.y - t * dy) * ASPECT);
}

const boxOf = p => p.box || p;
const footOf = b => ({ x: (b.x1 + b.x2) / 2, y: b.y2 });
const centerOf = b => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });

export class DrawerWatch {
  constructor({
    regions = [], openFrac = 0.55, closeFrac = 0.3, persist = 3, minVisible = 0.3, armPad = 0.035,
    seedFrames = 5, relearnMs = 600000, aloneMs = 2000, customerGraceMs = 5000, maxOpenMs = 45000,
    saleWindowMs = 20000, saleLagMs = 10000, salesFreshMs = 7200000, followMs = 3000, dwellMs = 400, minTravel = 0.45, cooldownMs = 120000,
  } = {}) {
    Object.assign(this, { openFrac, closeFrac, persist, minVisible, armPad, seedFrames, relearnMs, aloneMs, customerGraceMs, maxOpenMs, saleWindowMs, saleLagMs, salesFreshMs, followMs, dwellMs, minTravel, cooldownMs });
    this.quiet = [];
    this.sales = [];
    this.saleChecks = [];
    this.customerSeenAt = -Infinity;
    this.log = [];
    this.setRegions(regions);
  }

  setRegions(regions) {
    const ok = r => Array.isArray(r.points) && r.points.length >= 3;
    const poly = r => r.points.map(([x, y]) => [+x, +y]);
    const prev = new Map((this.drawers || []).map(d => [d.id + JSON.stringify(d.poly), d]));
    this.drawers = (regions || []).filter(r => r.kind === 'cash_drawer' && ok(r)).map(r => {
      const p = poly(r);
      const old = prev.get(r.id + JSON.stringify(p));
      if (old) { old.name = r.name || 'Касса'; return old; }
      const cells = [];
      for (let by = 0; by < HB; by++) for (let bx = 0; bx < WB; bx++) if (pointInPoly((bx + 0.5) / WB, (by + 0.5) / HB, p)) cells.push(by * WB + bx);
      return {
        id: r.id, name: r.name || 'Касса', poly: p, cells,
        ref: null, seed: 0, prev: null, open: false, up: 0, down: 0, openedAt: 0, lastOpenAt: -Infinity, frac: 0, visible: 0,
        openFrame: null, sent: {}, cool: {}, hands: new Map(),
      };
    });
    this.customers = (regions || []).filter(r => r.kind === 'cash_customer' && ok(r)).map(r => ({ id: r.id, poly: poly(r) }));
  }

  setQuiet(ranges) { this.quiet = Array.isArray(ranges) ? ranges : []; }

  // чек из кассовой системы: правило «открыт без продажи» работает, пока чеки приходят
  noteSale(atMs) {
    this.sales.push(atMs);
    if (this.sales.length > 500) this.sales.shift();
  }

  get anyOpen() { return this.drawers.some(d => d.open); }

  // принудительно принять текущий вид за «ящик закрыт»
  calibrate(gray) {
    const cur = blockStats(gray);
    for (const d of this.drawers) { d.ref = this.#take(cur, d.cells); d.open = false; d.up = d.down = 0; }
  }

  #take(cur, cells) {
    const ref = { mu: new Float32Array(N), sd: new Float32Array(N), z: new Float32Array(N * BB) };
    for (const i of cells) this.#copy(ref, cur, i, 1);
    return ref;
  }

  #copy(ref, cur, i, a) {
    ref.mu[i] += a * (cur.mu[i] - ref.mu[i]);
    ref.sd[i] += a * (cur.sd[i] - ref.sd[i]);
    for (let j = i * BB; j < (i + 1) * BB; j++) ref.z[j] += a * (cur.z[j] - ref.z[j]);
  }

  #moved(a, b, cells) {
    let n = 0;
    for (const i of cells) if (blockChanged(a, b, i)) n++;
    return cells.length ? n / cells.length : 1;
  }

  #masked(i, people) {
    const x = (i % WB + 0.5) / WB, y = (Math.floor(i / WB) + 0.5) / HB;
    for (const p of people) {
      const k = p.kpts;
      if (!k) {
        const b = boxOf(p);
        if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) return true;
        continue;
      }
      for (const [a, b] of ARMS) if (armDist(k, a, b, x, y) < this.armPad) return true;
      // торс и голова: сверху кассир наклоняется прямо над ящиком
      const ls = k[5], rs = k[6], lh = k[11], rh = k[12];
      if (ls && rs && Math.min(ls.c, rs.c) > 0.3) {
        const sw = Math.hypot(ls.x - rs.x, (ls.y - rs.y) * ASPECT);
        const sm = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, c: 1 };
        const hm = lh && rh && Math.min(lh.c, rh.c) > 0.3 ? { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, c: 1 } : sm;
        if (armDist([sm, hm], 0, 1, x, y) < 0.5 * sw) return true;
        const n = k[0];
        if (n && n.c > 0.3 && Math.hypot(x - n.x, (y - n.y) * ASPECT) < 0.4 * sw) return true;
      }
    }
    return false;
  }

  #inCustomer(p) { return this.customers.some(c => pointInPoly(p.x, p.y, c.poly)); }

  step(gray, people, t, { jpeg = null } = {}) {
    const out = { events: [], alerts: [] };
    if (!this.drawers.length) return out;
    const cur = blockStats(gray);
    people = people.filter(p => !p.group || p.group === 'person');

    for (const p of people) {
      const b = boxOf(p);
      if (this.#inCustomer(footOf(b)) || this.#inCustomer(centerOf(b))) this.customerSeenAt = t;
    }
    const noCustomer = this.customers.length > 0 && t - this.customerSeenAt > this.customerGraceMs && !inQuietHours(this.quiet, t);

    for (const d of this.drawers) {
      const vis = d.cells.filter(i => !this.#masked(i, people));
      d.visible = d.cells.length ? vis.length / d.cells.length : 0;

      if (!d.ref) {
        // эталон «закрыт» — первый спокойный вид зоны, когда над ней нет рук
        const calm = d.visible >= 0.8 && d.prev && this.#moved(d.prev, cur, vis) <= 0.05;
        d.seed = calm ? d.seed + 1 : 0;
        d.prev = this.#take(cur, d.cells);
        if (d.seed >= this.seedFrames) { d.ref = d.prev; d.prev = null; }
        continue;
      }
      if (d.visible >= this.minVisible) {
        let ch = 0;
        for (const i of vis) if (blockChanged(d.ref, cur, i)) ch++;
        d.frac = ch / vis.length;
        d.up = d.frac >= this.openFrac ? d.up + 1 : 0;
        d.down = d.frac <= this.closeFrac ? d.down + 1 : 0;
      }

      if (!d.open && d.up >= this.persist) {
        d.open = true; d.openedAt = t; d.openFrame = jpeg; d.sent = {}; d.stable = 0; d.prev = null;
        d.alone = noCustomer; d.aloneSince = noCustomer ? t : 0;
        out.events.push({ kind: 'open', drawer: d, at: t });
        this.saleChecks.push({ d, openedAt: t, openFrame: jpeg });
      } else if (d.open && d.down >= this.persist) {
        d.open = false; d.lastOpenAt = t;
        const ev = { kind: 'close', drawer: d, at: t, openMs: t - d.openedAt };
        out.events.push(ev);
        this.log.push({ id: d.id, openedAt: d.openedAt, closedAt: t });
        if (this.log.length > 200) this.log.shift();
      }

      if (!d.open) {
        if (d.down >= this.persist && d.visible >= 0.9) for (const i of vis) this.#copy(d.ref, cur, i, 0.05);
      } else {
        // зона давно не меняется и не похожа на эталон — эталон устарел (переставили кассу, начали с открытого)
        const still = d.visible >= 0.8 && d.prev && this.#moved(d.prev, cur, vis) <= 0.05;
        if (!still) { d.stableSince = t; d.prev = this.#take(cur, d.cells); }
        if (t - (d.stableSince ?? t) >= this.relearnMs) {
          d.ref = this.#take(cur, d.cells); d.open = false; d.up = d.down = 0; d.lastOpenAt = t;
          out.events.push({ kind: 'relearn', drawer: d, at: t });
          continue;
        }
        const openMs = t - d.openedAt;
        const fire = (kind, extra = {}) => {
          if (d.sent[kind] || t < (d.cool[kind] || 0)) return;
          d.sent[kind] = true; d.cool[kind] = t + this.cooldownMs;
          out.alerts.push({ kind, drawer: d, at: t, openedAt: d.openedAt, openMs, openFrame: d.openFrame, ...extra });
        };
        if (noCustomer) { if (!d.aloneSince) d.aloneSince = t; } else d.aloneSince = 0;
        if (d.aloneSince && t - d.aloneSince >= this.aloneMs) fire('open_no_customer');
        if (openMs >= this.maxOpenMs) fire('open_long');
      }

      this.#hands(d, people, t, out, jpeg);
    }
    // чек мог прийти с опозданием — проверяем открытие не сразу
    const due = this.saleChecks.filter(c => t - c.openedAt >= this.saleWindowMs + this.saleLagMs);
    this.saleChecks = this.saleChecks.filter(c => !due.includes(c));
    for (const c of due) {
      const feedAlive = this.sales.some(s => c.openedAt - s <= this.salesFreshMs && s <= t);
      if (!feedAlive || inQuietHours(this.quiet, c.openedAt) || t < (c.d.cool.open_no_sale || 0)) continue;
      if (this.sales.some(s => Math.abs(s - c.openedAt) <= this.saleWindowMs)) continue;
      c.d.cool.open_no_sale = t + this.cooldownMs;
      out.alerts.push({ kind: 'open_no_sale', drawer: c.d, at: t, openedAt: c.openedAt, openMs: (c.d.open ? t : c.d.lastOpenAt) - c.openedAt, openFrame: c.openFrame });
    }
    return out;
  }

  // рука была в открытом ящике и ушла к телу; покупателю ничего не передавали и от него не брали
  #hands(d, people, t, out, jpeg) {
    const live = d.open || t - d.lastOpenAt <= 1500;
    for (const p of people) {
      const k = p.kpts;
      if (!k || k.length < 17) continue;
      const id = p.id ?? 0;
      for (const wi of [L_WR, R_WR]) {
        const key = `${id}:${wi}`;
        let h = d.hands.get(key);
        if (!h) { h = { touchAt: -Infinity, custAt: -Infinity, nearSince: 0, skip: false, in: false, at: t }; d.hands.set(key, h); }
        h.at = t;
        const w = k[wi];
        if (!w || w.c < 0.5) { h.nearSince = 0; h.in = false; continue; }
        if (this.#inCustomer(w)) { h.custAt = t; h.skip = true; }
        if (live && pointInPoly(w.x, w.y, d.poly)) {
          if (!h.in) h.skip = t - h.custAt <= this.followMs;
          h.in = true; h.touchAt = t; h.touchFrame = jpeg; h.touchPoint = { x: w.x, y: w.y }; h.nearSince = 0;
          continue;
        }
        h.in = false;
        if (t - h.touchAt > this.followMs) { h.nearSince = 0; continue; }
        // кисть должна уйти от ящика заметно: рука, лежащая на краю ящика, не считается
        const sw = Math.hypot(k[5].x - k[6].x, (k[5].y - k[6].y) * ASPECT);
        const moved = Math.hypot(w.x - h.touchPoint.x, (w.y - h.touchPoint.y) * ASPECT) >= this.minTravel * sw;
        if (h.skip || !moved || !handAtBody(k, wi)) { h.nearSince = 0; continue; }
        if (!h.nearSince) { h.nearSince = t; continue; }
        if (t - h.nearSince < this.dwellMs || t < (d.cool.to_body || 0)) continue;
        d.cool.to_body = t + this.cooldownMs;
        out.alerts.push({
          kind: 'to_body', drawer: d, at: t, openedAt: d.openedAt, openMs: t - d.openedAt, openFrame: d.openFrame,
          trackId: id, hand: wi === L_WR ? 'left' : 'right', touchAt: h.touchAt, touchFrame: h.touchFrame, box: { ...boxOf(p) },
        });
        h.touchAt = -Infinity; h.nearSince = 0;
      }
    }
    for (const [key, h] of d.hands) if (t - h.at > 30000) d.hands.delete(key);
  }

  async observe(jpeg, people, t) {
    if (!this.drawers.length) return { events: [], alerts: [] };
    return this.step(await decodeGray(jpeg), people, t, { jpeg });
  }
}

// кисть у своего бедра или у торса — при любом повороте тела, в том числе на камере сверху
export function handAtBody(k, wi) {
  const ls = k[5], rs = k[6], w = k[wi];
  if (!w || !ls || !rs || Math.min(ls.c, rs.c) <= 0.3) return false;
  const dist = (a, b) => Math.hypot(a.x - b.x, (a.y - b.y) * ASPECT);
  const hip = k[wi === L_WR ? 11 : 12];
  if (hip && hip.c > 0.3 && dist(w, hip) < 0.35 * dist(ls, rs)) return true;
  return handSpot({ kpts: k.map((q, i) => (i === (wi === L_WR ? R_WR : L_WR) ? { ...q, c: 0 } : q)) }) === 'body';
}

export const DRAWER_TEXT = {
  open_no_customer: 'денежный ящик открыт, а покупателя у кассы нет',
  open_long: 'денежный ящик открыт слишком долго',
  open_no_sale: 'денежный ящик открыт, а чека в кассовой системе нет',
  to_body: 'рука из открытого денежного ящика ушла к карману или к телу, покупателю ничего не передавали',
};

export async function drawerEvidence(alert, nowJpeg) {
  const pw = 640, ph = 360;
  const pts = alert.drawer.poly.map(([x, y]) => `${(x * pw).toFixed(1)},${(y * ph).toFixed(1)}`).join(' ');
  const mark = `<polygon points="${pts}" fill="none" stroke="#ff2a2a" stroke-width="3"/>`;
  const svg = (text, color) => Buffer.from(`<svg width="${pw}" height="${ph}">${mark}<rect x="0" y="0" width="${text.length * 11 + 16}" height="26" fill="${color}"/><text x="8" y="19" font-family="sans-serif" font-size="16" fill="#fff">${text}</text></svg>`);
  const panel = (jpeg, text, color) => sharp(jpeg).resize(pw, ph, { fit: 'fill' }).composite([{ input: svg(text, color) }]).jpeg({ quality: 82 }).toBuffer();
  const parts = [];
  if (alert.touchFrame && alert.touchFrame !== nowJpeg) parts.push(await panel(alert.touchFrame, 'РУКА В ЯЩИКЕ', '#b9770e'));
  else if (alert.openFrame && alert.openFrame !== nowJpeg) parts.push(await panel(alert.openFrame, 'ЯЩИК ОТКРЫЛИ', '#b9770e'));
  parts.push(await panel(nowJpeg, 'СЕЙЧАС', '#c0392b'));
  return sharp({ create: { width: pw * parts.length, height: ph, channels: 3, background: '#000' } })
    .composite(parts.map((input, i) => ({ input, left: i * pw, top: 0 }))).jpeg({ quality: 82 }).toBuffer();
}

export const DRAWER_PROMPT = `Перед тобой один или два кадра камеры над кассой магазина. Красный контур — место денежного ящика. Слева «ЯЩИК ОТКРЫЛИ» или «РУКА В ЯЩИКЕ» (если есть), справа «СЕЙЧАС».
Ответь строго JSON: {"drawer_open": true|false, "customer_present": true|false, "cash_in_hand": true|false, "cash_to": "покупателю|в ящик|в карман|под одежду|в сумку|не видно", "confidence": 0..1, "comment": "одно короткое предложение"}.
drawer_open — в контуре виден выдвинутый ящик с деньгами. customer_present — у кассы стоит покупатель, а не только сотрудник. cash_in_hand — в руке сотрудника видны деньги.`;

export function judgeDrawer(alert, v) {
  if (!v || typeof v !== 'object') return { send: true, note: 'без облачной проверки' };
  const conf = Number(v.confidence) || 0;
  const note = v.comment ? `Облако: ${v.comment}` : 'облако подтвердило';
  if (conf < 0.7) return { send: true, note };
  if (v.drawer_open === false) return { send: false, note: v.comment || 'облако: ящик закрыт' };
  if (alert.kind === 'open_no_customer' && v.customer_present === true) return { send: false, note: v.comment || 'облако: покупатель у кассы' };
  if (alert.kind === 'to_body' && (v.cash_to === 'покупателю' || v.cash_to === 'в ящик')) return { send: false, note: v.comment || 'облако: деньги отданы покупателю' };
  return { send: true, note };
}
