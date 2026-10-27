/**
 * Подозрение на сокрытие товара — по скелету, локально, без облака.
 *
 * Последовательность для одной руки одного человека:
 *   1. рука ВЫТЯНУТА к полке и находится в зоне полки;
 *   2. в течение reachWindowMs после этого рука оказывается у тела —
 *      у кармана (рядом с бедром) или под одеждой (внутри торса);
 *   3. задерживается там dwellMs, а сам человек почти стоит на месте.
 *
 * Почему «вытянута»: человек, проходящий мимо полки, на плоской картинке тоже
 * оказывается рукой «в зоне полки», а потом его рука висит у бедра — со стороны
 * точь-в-точь «взял и в карман». Касание засчитываем, только если рука
 * распрямлена (кисть далеко от своего плеча) и при этом не висит у бедра.
 * Рука у лица — телефон, очки — касанием не считается.
 *
 * «Под одежду» по умолчанию выключено: товар, который держат перед грудью и
 * читают этикетку, на скелете неотличим от «сунул под куртку». На прогоне по
 * реальным позам это правило давало ложные тревоги в большинстве проходов.
 *
 * Результат — подозрение, а не обвинение: решение принимает человек по снимку.
 */

const L_SH = 5, R_SH = 6, L_WR = 9, R_WR = 10, L_HIP = 11, R_HIP = 12;

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Опорные точки тела или null, если скелет виден ненадёжно. */
export function bodyFrame(kpts, minConf, wristConf = 0.5) {
  if (!kpts || kpts.length < 17) return null;
  const k = i => (kpts[i] && kpts[i].c >= minConf ? kpts[i] : null);
  const ls = k(L_SH), rs = k(R_SH), lh = k(L_HIP), rh = k(R_HIP);
  if (!ls || !rs || !lh || !rh) return null;
  const sh = mid(ls, rs), hip = mid(lh, rh);
  const L = dist(sh, hip);
  if (L < 0.02) return null;
  const wk = i => (kpts[i] && kpts[i].c >= wristConf ? kpts[i] : null);
  return { ls, rs, lh, rh, sh, hip, L, wrists: { left: wk(L_WR), right: wk(R_WR) } };
}

/** Где кисть относительно тела: 'карман', 'под одежду' или null. */
export function concealSpot(w, f, { torso = false } = {}) {
  for (const h of [f.lh, f.rh]) {
    const nearHip = dist(w, h) < 0.25 * f.L;
    const notHanging = w.y < h.y + 0.12 * f.L;
    if (nearHip && notHanging) return 'карман';
  }
  if (!torso) return null;
  const xs = [f.ls.x, f.rs.x, f.lh.x, f.rh.x];
  const inX = w.x > Math.min(...xs) && w.x < Math.max(...xs);
  const inY = w.y > f.sh.y + 0.25 * f.L && w.y < f.hip.y - 0.05 * f.L;
  return inX && inY ? 'под одежду' : null;
}

export function isReaching(w, f, hand) {
  const shoulder = hand === 'left' ? f.ls : f.rs;
  return dist(w, shoulder) > 0.8 * f.L && dist(w, f.hip) > 0.55 * f.L;
}

export class ShelfWatch {
  constructor({ regions = [], reachWindowMs = 4000, dwellMs = 500, cooldownMs = 60000, minConf = 0.35, maxSpeed = 0.15, torso = false } = {}) {
    this.reachWindowMs = reachWindowMs;
    this.dwellMs = dwellMs;
    this.cooldownMs = cooldownMs;
    this.minConf = minConf;
    this.maxSpeed = maxSpeed;
    this.torso = torso;
    this.state = new Map();
    this.setRegions(regions);
  }

  setRegions(regions) {
    this.shelves = (regions || [])
      .filter(r => r.kind === 'shelf' && Array.isArray(r.points) && r.points.length >= 3)
      .map(r => ({ id: r.id, name: r.name || 'Полка', poly: r.points.map(([x, y]) => [+x, +y]) }));
  }

  #shelfAt(w) {
    return this.shelves.find(s => pointInPolygon(w, s.poly)) || null;
  }

  /**
   * @param tracks треки трекера с kpts
   * @param frame  текущий кадр — запоминается как доказательство момента у полки
   * @returns тревоги [{ trackId, hand, shelf, spot, reach, conceal }]
   */
  observe(tracks, nowMs, frame = null) {
    const alerts = [];
    if (!this.shelves.length) return alerts;

    for (const tr of tracks) {
      if ((tr.group && tr.group !== 'person') || tr.lastSeen !== nowMs) continue;
      const f = bodyFrame(tr.kpts, this.minConf);
      if (!f) continue;
      let st = this.state.get(tr.id);
      if (!st) { st = { hands: {}, cooldownUntil: 0, at: nowMs }; this.state.set(tr.id, st); }
      st.at = nowMs;
      const standing = Math.hypot(tr.vx || 0, tr.vy || 0) < this.maxSpeed;

      for (const hand of ['left', 'right']) {
        const w = f.wrists[hand];
        if (!w) continue;
        const h = st.hands[hand] || (st.hands[hand] = { touch: null, nearSince: 0, spot: null });

        const shelf = this.#shelfAt(w);
        if (shelf && isReaching(w, f, hand)) {
          h.touch = { at: nowMs, shelf, point: { x: w.x, y: w.y }, box: { ...tr.box }, frame };
          h.nearSince = 0;
          continue;
        }

        const spot = concealSpot(w, f, { torso: this.torso });
        const recent = h.touch && nowMs - h.touch.at <= this.reachWindowMs;
        if (!spot || !recent || !standing) { if (!spot) h.nearSince = 0; continue; }

        if (!h.nearSince) { h.nearSince = nowMs; h.spot = spot; continue; }
        if (nowMs - h.nearSince < this.dwellMs || nowMs < st.cooldownUntil) continue;

        alerts.push({
          trackId: tr.id, hand, shelf: h.touch.shelf, spot: h.spot,
          reach: { at: h.touch.at, point: h.touch.point, box: h.touch.box, frame: h.touch.frame },
          conceal: { at: nowMs, point: { x: w.x, y: w.y }, box: { ...tr.box } },
        });
        st.cooldownUntil = nowMs + this.cooldownMs;
        h.touch = null;
        h.nearSince = 0;
      }
    }

    for (const [id, st] of this.state) if (nowMs - st.at > 30_000) this.state.delete(id);
    return alerts;
  }
}
