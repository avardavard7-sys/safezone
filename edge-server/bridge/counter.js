/**
 * Подсчёт посетителей по линии на входе.
 *
 * Линия задаётся двумя точками в долях кадра и стороной, которая считается
 * «внутри». Человек — это трек трекера; его положение берём у ног (низ центра
 * рамки): точка у ног пересекает порог правильно при любой установке камеры,
 * а центр рамки при камере сбоку пересекает линию раньше времени.
 *
 * Считаем не уникальные ID, а пересечения: трек не означает личность, и подсчёт
 * по уникальным ID задваивается при каждой смене номера.
 */

const MARGIN = 0.015;

export function sideOf(line, p) {
  return (line.x2 - line.x1) * (p.y - line.y1) - (line.y2 - line.y1) * (p.x - line.x1);
}

function segmentsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

/** Расстояние от точки до прямой линии в долях кадра. */
function distanceToLine(line, p) {
  const len = Math.hypot(line.x2 - line.x1, line.y2 - line.y1) || 1e-9;
  return Math.abs(sideOf(line, p)) / len;
}

/**
 * Пересёк ли шаг prev → cur отрезок линии, и в какую сторону.
 * «Левая» сторона — слева, если смотреть из первой точки линии во вторую.
 */
export function crossing(line, prev, cur) {
  const a = { x: line.x1, y: line.y1 }, b = { x: line.x2, y: line.y2 };
  if (!segmentsIntersect(a, b, prev, cur)) return null;
  const was = sideOf(line, prev), now = sideOf(line, cur);
  if (Math.sign(was) === Math.sign(now)) return null;
  const nowLeft = now > 0;
  const entering = line.inside === 'right' ? !nowLeft : nowLeft;
  return entering ? 'in' : 'out';
}

export function footPoint(track) {
  const b = track.box;
  return { x: (b.x1 + b.x2) / 2, y: b.y2 };
}

export class LineCounter {
  constructor({ lines = [], minHits = 2 } = {}) {
    this.minHits = minHits;
    this.setLines(lines);
    this.state = new Map();
  }

  setLines(lines) {
    this.lines = (lines || []).filter(l =>
      [l.x1, l.y1, l.x2, l.y2].every(v => Number.isFinite(+v)) &&
      Math.hypot(l.x2 - l.x1, l.y2 - l.y1) > 0.02,
    ).map(l => ({ ...l, x1: +l.x1, y1: +l.y1, x2: +l.x2, y2: +l.y2 }));
  }

  /**
   * @param {Array} tracks треки трекера на этом кадре
   * @returns {Array<{lineId, direction, trackId, at}>}
   */
  observe(tracks, nowMs) {
    const events = [];

    for (const tr of tracks) {
      if (tr.group && tr.group !== 'person') continue;
      if (tr.lastSeen !== nowMs) continue;
      const p = footPoint(tr);

      for (const line of this.lines) {
        const key = `${tr.id}:${line.id}`;
        const st = this.state.get(key);
        if (!st) {
          this.state.set(key, { anchor: p, last: null, hits: 1, at: nowMs });
          continue;
        }
        st.hits++;
        st.at = nowMs;

        // у самого порога точка дрожит — ждём, пока человек отойдёт от линии
        if (distanceToLine(line, p) < MARGIN) continue;

        const dir = crossing(line, st.anchor, p);
        st.anchor = p;
        if (!dir || st.hits < this.minHits) continue;
        // один и тот же человек, топчущийся в дверях, не даёт вход-вход-вход
        if (st.last === dir) continue;
        st.last = dir;
        events.push({ lineId: line.id, direction: dir, trackId: tr.id, at: nowMs });
      }
    }

    for (const [key, st] of this.state) {
      if (nowMs - st.at > 30_000) this.state.delete(key);
    }
    return events;
  }
}
