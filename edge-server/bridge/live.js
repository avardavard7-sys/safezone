/**
 * Какие камеры держат непрерывный поток и зачем.
 *
 *  - подсчёт: камера с линией, если у объекта включён подсчёт посетителей;
 *  - рамки: камера, которую кто-то прямо сейчас смотрит в полном виде,
 *    если включены рамки в LIVE.
 *
 * Рамки для всей сетки не считаем: 16 камер по 5 кадров в секунду положат
 * любой компьютер на объекте. Поэтому потоков рамок не больше maxOverlay.
 */
export function planAnalyzers({ cams = [], countLines = [], regions = [], watched = new Set(), features = null, maxOverlay = 4, faceCameras = new Set(), blacklistSize = 0 }) {
  const countOn = Boolean(features && features.visitor_count);
  const boxesOn = Boolean(features && features.people_boxes);
  const theftOn = Boolean(features && features.theft_shelf);
  const cashOn = Boolean(features && features.theft_cashier);
  const facesOn = Boolean(features && features.blacklist) && blacklistSize > 0;
  const queueOn = Boolean(features && features.queue);
  const plan = new Map();
  let overlays = 0;

  for (const cam of cams) {
    const lines = countOn ? countLines.filter(l => l.camera_id === cam.id) : [];
    let overlay = false;
    if (boxesOn && watched.has(cam.id) && overlays < maxOverlay) {
      overlay = true;
      overlays++;
    }
    const shelves = theftOn ? regions.filter(r => r.camera_id === cam.id && r.kind === 'shelf') : [];
    const cashZones = cashOn ? regions.filter(r => r.camera_id === cam.id && (r.kind === 'cash_drawer' || r.kind === 'cash_customer')) : [];
    const cash = cashZones.some(r => r.kind === 'cash_drawer');
    const faces = facesOn && faceCameras.has(cam.id);
    const queueRegions = queueOn ? regions.filter(r => r.camera_id === cam.id && r.kind === 'queue') : [];
    const queue = queueRegions.length > 0;
    if (lines.length || overlay || shelves.length || cash || faces || queue) {
      plan.set(cam.id, { cam, lines, shelves, cashZones, queueRegions, count: lines.length > 0, overlay, theft: shelves.length > 0, cash, faces, queue });
    }
  }
  return plan;
}

const r = v => Math.round(v * 1000) / 1000;

/** Рамки людей для панели: только обновлённые на этом кадре, координаты в долях кадра. */
export function tracksPayload(cameraId, tracks, nowMs) {
  return {
    camera_id: cameraId,
    t: nowMs,
    tracks: tracks
      .filter(tr => (!tr.group || tr.group === 'person') && tr.lastSeen === nowMs)
      .map(tr => ({ id: tr.id, b: [r(tr.box.x1), r(tr.box.y1), r(tr.box.x2), r(tr.box.y2)] })),
  };
}

/** Не чаще одного сообщения в intervalMs на ключ — канал Realtime не резиновый. */
export class Throttle {
  constructor(intervalMs) { this.intervalMs = intervalMs; this.last = new Map(); }
  ready(key, nowMs) {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < this.intervalMs) return false;
    this.last.set(key, nowMs);
    return true;
  }
}

/** Камеры, которые смотрят зрители, из состояния присутствия канала. */
export function watchedFromPresence(state) {
  const out = new Set();
  for (const metas of Object.values(state || {})) {
    for (const m of metas || []) if (m && typeof m.camera_id === 'string') out.add(m.camera_id);
  }
  return out;
}
