// tiles.js — «дальнозоркость» (v7.4): тайловый проход детектора.
//
// Проблема: кадр 2304×1296 ужимается в 640×640 → человек на дальнем плане
// превращается в 20-30 пикселей и детектор его не видит.
// Решение: режем кадр на перекрывающиеся тайлы, каждый детектим отдельно
// (в тайле дальний человек в grid раз крупнее), склеиваем через общий NMS.
//
// Цена: grid² вызовов детектора вместо одного (grid=2 → 4×~300мс).
// Поэтому включается умно (см. TILED_DETECT в index.js), а не на каждый кадр.

import sharp from 'sharp';

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(1e-9, (a.x2 - a.x1) * (a.y2 - a.y1));
  const areaB = Math.max(1e-9, (b.x2 - b.x1) * (b.y2 - b.y1));
  return inter / (areaA + areaB - inter);
}

/** Общий NMS по классам для склейки находок из разных тайлов и полного кадра. */
export function mergeDets(...detLists) {
  const all = detLists.flat().filter(Boolean);
  all.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const d of all) {
    const dup = keep.some(k => {
      if (k.cls !== d.cls) return false;
      if (iou(k, d) > 0.5) return true;
      // мелкие боксы из соседних тайлов чуть смещены → IoU мал, ловим по центрам
      const cd = Math.hypot((k.x1 + k.x2 - d.x1 - d.x2) / 2, (k.y1 + k.y2 - d.y1 - d.y2) / 2);
      const size = Math.max(k.x2 - k.x1, k.y2 - k.y1, d.x2 - d.x1, d.y2 - d.y1);
      return cd < size * 0.6;
    });
    if (!dup) keep.push(d);
  }
  return keep;
}

/**
 * Тайловый проход.
 * @param {Buffer} jpegBuffer   исходный кадр
 * @param {function} detectFn   детектор (Buffer → dets с норм. коорд. 0..1)
 * @param {object} opts         { grid=2, overlap=0.15 }
 * @returns {Promise<Array>}    dets в нормализованных координатах ИСХОДНОГО кадра
 */
export async function tiledDetect(jpegBuffer, detectFn, opts = {}) {
  const grid = Math.max(2, Math.min(4, opts.grid ?? 2));
  const overlap = Math.min(0.4, Math.max(0.05, opts.overlap ?? 0.2));

  const img = sharp(jpegBuffer);
  const { width: W, height: H } = await img.metadata();

  // размер тайла с перекрытием: шаг = (1 - overlap-доля от тайла)
  const tileW = Math.ceil(W / (grid - (grid - 1) * overlap));
  const tileH = Math.ceil(H / (grid - (grid - 1) * overlap));
  const stepX = Math.floor(tileW * (1 - overlap));
  const stepY = Math.floor(tileH * (1 - overlap));

  const results = [];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const left = Math.min(gx * stepX, Math.max(0, W - tileW));
      const top = Math.min(gy * stepY, Math.max(0, H - tileH));
      const w = Math.min(tileW, W - left);
      const h = Math.min(tileH, H - top);
      if (w < 32 || h < 32) continue;

      const tileBuf = await sharp(jpegBuffer)
        .extract({ left, top, width: w, height: h })
        .jpeg({ quality: 92 })
        .toBuffer();

      const dets = await detectFn(tileBuf);
      // координаты тайла (0..1 внутри тайла) → глобальные (0..1 кадра)
      for (const d of dets) {
        results.push({
          ...d,
          x1: (left + d.x1 * w) / W,
          y1: (top + d.y1 * h) / H,
          x2: (left + d.x2 * w) / W,
          y2: (top + d.y2 * h) / H,
        });
      }
    }
  }
  return mergeDets(results);
}
