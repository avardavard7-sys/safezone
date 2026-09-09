// tracker.js — лёгкий мультиобъектный трекер (логика ByteTrack: двухэтапный
// IoU-матчинг high/low confidence). Чистый JS, без нейросетей — только алгоритм.
//
// Что даёт:
//  - стабильные track ID для людей и сумок между кадрами
//  - реальные скорости (нормализованные единицы кадра / сек)
//  - "стоит на месте N секунд" (лойтеринг), "сумка без хозяина N секунд"
//
// Честное ограничение: скорость/непрерывность осмысленны внутри burst-серий
// (интервалы 0.2-2 сек). Между циклами по 15-30 сек трекер сохраняет ID по
// геометрии "кто ближе" — при 3+ людях возможна путаница ID, это ре-идентификация
// без внешности. Логика, которая от этого зависит (лойтеринг), задизайнена
// терпимой к редким свапам.

const BAG_CLASSES = new Set(['backpack', 'handbag', 'suitcase']);

let nextId = 1;

class Track {
  constructor(det, nowMs) {
    this.id = nextId++;
    this.cls = det.cls || 'person';
    this.group = BAG_CLASSES.has(this.cls) ? 'bag' : this.cls; // сумки матчим между собой
    this.box = { x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2 };
    this.conf = det.conf;
    this.vx = 0; this.vy = 0;           // норм.ед/сек, сглаженные
    this.hits = 1;
    this.misses = 0;
    this.confirmed = false;
    this.firstSeen = nowMs;
    this.lastSeen = nowMs;
    this.stationarySince = nowMs;
    this.history = [{ cx: this.cx(), cy: this.cy(), t: nowMs }]; // кольцо до 40 точек
    this.kpts = det.kpts || null;        // последние ключевые точки (для людей)
  }
  cx() { return (this.box.x1 + this.box.x2) / 2; }
  cy() { return (this.box.y1 + this.box.y2) / 2; }
  w()  { return this.box.x2 - this.box.x1; }
  h()  { return this.box.y2 - this.box.y1; }
  speed() { return Math.hypot(this.vx, this.vy); }

  predict(nowMs) {
    const dt = Math.min(2.0, (nowMs - this.lastSeen) / 1000); // экстраполируем максимум на 2с
    return {
      x1: this.box.x1 + this.vx * dt, y1: this.box.y1 + this.vy * dt,
      x2: this.box.x2 + this.vx * dt, y2: this.box.y2 + this.vy * dt,
    };
  }

  update(det, nowMs) {
    const dt = (nowMs - this.lastSeen) / 1000;
    const ncx = (det.x1 + det.x2) / 2, ncy = (det.y1 + det.y2) / 2;
    if (dt > 0.02 && dt < 5) {
      const ivx = (ncx - this.cx()) / dt;
      const ivy = (ncy - this.cy()) / dt;
      // alpha-beta сглаживание скорости
      this.vx = 0.6 * ivx + 0.4 * this.vx;
      this.vy = 0.6 * ivy + 0.4 * this.vy;
    } else if (dt >= 5) {
      // после долгого разрыва мгновенная "скорость" — артефакт, не считаем её
      this.vx = 0; this.vy = 0;
    }
    this.box = { x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2 };
    this.conf = det.conf;
    if (det.kpts) this.kpts = det.kpts;
    this.hits++;
    this.misses = 0;
    this.lastSeen = nowMs;
    if (this.hits >= 2) this.confirmed = true;
    // критерий "двигается": смещение центра за апдейт заметнее 3% кадра/сек
    if (this.speed() > 0.03) this.stationarySince = nowMs;
    this.history.push({ cx: ncx, cy: ncy, t: nowMs });
    if (this.history.length > 40) this.history.shift();
  }

  stationaryForSec(nowMs) { return (nowMs - this.stationarySince) / 1000; }
  ageSec(nowMs) { return (nowMs - this.firstSeen) / 1000; }
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(1e-9, (a.x2 - a.x1) * (a.y2 - a.y1));
  const areaB = Math.max(1e-9, (b.x2 - b.x1) * (b.y2 - b.y1));
  return inter / (areaA + areaB - inter);
}

function centerDist(a, b) {
  return Math.hypot((a.x1 + a.x2 - b.x1 - b.x2) / 2, (a.y1 + a.y2 - b.y1 - b.y2) / 2);
}

class CameraTracker {
  constructor(opts = {}) {
    this.tracks = [];
    this.ttlMs = opts.ttlMs ?? 60_000;        // сколько держим потерянный трек
    this.iouThr = opts.iouThr ?? 0.15;
    this.centerThr = opts.centerThr ?? 0.12;  // запасной матч по центру (мелкие боксы)
    this.highConf = opts.highConf ?? 0.5;
  }

  /**
   * @param {Array} dets  [{cls, conf, x1..y2 (норм. 0..1), kpts?}]
   * @param {number} nowMs
   * @returns {Array<Track>} актуальные треки (обновлённые этим кадром + недавно потерянные)
   */
  update(dets, nowMs) {
    // двухэтапный матчинг: сначала уверенные детекции, потом слабые к остаткам
    const high = dets.filter(d => d.conf >= this.highConf);
    const low  = dets.filter(d => d.conf <  this.highConf);
    let unmatchedTracks = [...this.tracks];

    const matchStage = (pool) => {
      const pairs = [];
      for (const tr of unmatchedTracks) {
        const pred = tr.predict(nowMs);
        // ворота по центру растут со временем разрыва: человек проходит ~1.8 своих
        // "габаритов" в секунду; потолок 0.45 кадра (иначе после долгих пауз
        // сматчим кого угодно с кем угодно)
        const dt = (nowMs - tr.lastSeen) / 1000;
        const gate = Math.min(0.45, Math.max(this.centerThr, dt * 1.8 * Math.max(tr.w(), tr.h()) + 0.05));
        for (let di = 0; di < pool.length; di++) {
          const d = pool[di];
          if (d.__used) continue;
          const sameGroup = (BAG_CLASSES.has(d.cls) ? 'bag' : d.cls) === tr.group;
          if (!sameGroup) continue;
          const i = iou(pred, d);
          const cd = centerDist(pred, d);
          if (i >= this.iouThr || cd <= gate) {
            pairs.push({ tr, d, score: i + Math.max(0, gate - cd) / Math.max(gate, 1e-6) });
          }
        }
      }
      pairs.sort((a, b) => b.score - a.score);
      const usedTr = new Set();
      for (const p of pairs) {
        if (usedTr.has(p.tr) || p.d.__used) continue;
        p.tr.update(p.d, nowMs);
        p.d.__used = true;
        usedTr.add(p.tr);
      }
      unmatchedTracks = unmatchedTracks.filter(t => !usedTr.has(t));
    };

    matchStage(high);
    matchStage(low);

    // непойманные уверенные детекции → новые треки
    for (const d of high) if (!d.__used) this.tracks.push(new Track(d, nowMs));
    for (const d of dets) delete d.__used;

    // старение и чистка
    for (const tr of unmatchedTracks) tr.misses++;
    this.tracks = this.tracks.filter(t => nowMs - t.lastSeen <= this.ttlMs);

    return this.tracks;
  }

  persons(nowMs, freshMs = 4000) {
    return this.tracks.filter(t => t.group === 'person' && t.confirmed && nowMs - t.lastSeen <= freshMs);
  }
  bags(nowMs, freshMs = 8000) {
    return this.tracks.filter(t => t.group === 'bag' && t.confirmed && nowMs - t.lastSeen <= freshMs);
  }

  /** Локальные сигналы уровня сцены — без единого API-вызова */
  sceneHints(nowMs, opts = {}) {
    const loiterSec = opts.loiterSec ?? 180;
    const abandonedSec = opts.abandonedSec ?? 45;
    const nearDist = opts.nearDist ?? 0.18;
    const hints = [];

    const ppl = this.persons(nowMs);
    for (const p of ppl) {
      if (p.stationaryForSec(nowMs) >= loiterSec && p.ageSec(nowMs) >= loiterSec) {
        hints.push({ type: 'loitering', trackId: p.id, detail: `человек #${p.id} стоит на месте ~${Math.round(p.stationaryForSec(nowMs) / 60)} мин` });
      }
      if (p.speed() > 0.45) {
        hints.push({ type: 'running', trackId: p.id, detail: `человек #${p.id} быстро перемещается` });
      }
    }
    for (const b of this.bags(nowMs)) {
      const owner = ppl.some(p => centerDist(p.box, b.box) < nearDist);
      if (!owner && b.stationaryForSec(nowMs) >= abandonedSec) {
        hints.push({ type: 'abandoned_local', trackId: b.id, detail: `${b.cls} #${b.id} лежит без людей рядом ~${Math.round(b.stationaryForSec(nowMs))} сек` });
      }
    }
    return hints;
  }
}

const trackers = {}; // camId → CameraTracker
export function getTracker(camId, opts) {
  if (!trackers[camId]) trackers[camId] = new CameraTracker(opts);
  return trackers[camId];
}
export { CameraTracker };
