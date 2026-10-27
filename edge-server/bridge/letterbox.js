// letterbox.js — общий препроцессинг для всех ONNX-моделей.
// Вместо fit:'fill' (растягивание, ломающее пропорции) делаем letterbox:
// вписываем кадр с сохранением пропорций, поля добиваем серым (114,114,114).
// Возвращаем параметры трансформации, чтобы координаты можно было
// точно вернуть в систему ИСХОДНОГО кадра (нормализованные 0..1).

import sharp from 'sharp';
import ort from 'onnxruntime-node';

/**
 * @param {Buffer} jpegBuffer  исходный JPEG
 * @param {number} size        сторона квадратного входа модели (напр. 640)
 * @param {object} opts        { pad: цвет поля, scale01: делить ли на 255, bgr: порядок каналов }
 * @returns {tensor, scale, padX, padY, width, height, aspect}
 */
export async function letterbox(jpegBuffer, size, opts = {}) {
  const { pad = 114, scale01 = true, bgr = false, topLeft = false } = opts;
  const img = sharp(jpegBuffer);
  const meta = await img.metadata();
  const W = meta.width, H = meta.height;
  const r = Math.min(size / W, size / H);
  const nw = Math.max(1, Math.round(W * r));
  const nh = Math.max(1, Math.round(H * r));
  const padX = topLeft ? 0 : Math.floor((size - nw) / 2);
  const padY = topLeft ? 0 : Math.floor((size - nh) / 2);

  const { data } = await img
    .resize(nw, nh, { fit: 'fill' })
    .extend({
      top: padY,
      bottom: size - nh - padY,
      left: padX,
      right: size - nw - padX,
      background: { r: pad, g: pad, b: pad },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = size * size;
  const chw = new Float32Array(3 * n);
  const div = scale01 ? 255 : 1;
  for (let i = 0; i < n; i++) {
    const R = data[i * 3], G = data[i * 3 + 1], B = data[i * 3 + 2];
    if (bgr) {
      chw[i] = B / div; chw[n + i] = G / div; chw[2 * n + i] = R / div;
    } else {
      chw[i] = R / div; chw[n + i] = G / div; chw[2 * n + i] = B / div;
    }
  }

  return {
    tensor: new ort.Tensor('float32', chw, [1, 3, size, size]),
    scale: r, padX, padY, width: W, height: H, aspect: W / H,
  };
}

/** Точка из пространства letterbox (пиксели входа модели) → нормализованные 0..1 координаты исходного кадра */
export function unboxPoint(x, y, lb) {
  return {
    x: Math.min(1, Math.max(0, (x - lb.padX) / lb.scale / lb.width)),
    y: Math.min(1, Math.max(0, (y - lb.padY) / lb.scale / lb.height)),
  };
}

/** Бокс (x1,y1,x2,y2 в пикселях входа модели) → нормализованный бокс исходного кадра */
export function unboxRect(x1, y1, x2, y2, lb) {
  const a = unboxPoint(x1, y1, lb);
  const b = unboxPoint(x2, y2, lb);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}
