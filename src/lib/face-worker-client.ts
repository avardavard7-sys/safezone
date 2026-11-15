'use client';

/**
 * Клиент фонового потока распознавания лиц (public/face-worker.js).
 * Один поток на вкладку: модели загружаются один раз и не блокируют страницу.
 */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (m: any) => void>();
let readyPromise: Promise<void> | null = null;

function getWorker() {
  if (!worker) {
    worker = new Worker('/face-worker.js');
    worker.onmessage = ev => { const cb = pending.get(ev.data.id); if (cb) { pending.delete(ev.data.id); cb(ev.data); } };
    worker.onerror = ev => {
      // поток не загрузился — отвечаем всем ожидающим, чтобы интерфейс не завис
      const msg = ev.message || 'фоновый поток распознавания не запустился';
      pending.forEach(cb => cb({ type: 'error', message: msg }));
      pending.clear();
      readyPromise = null;
    };
  }
  return worker;
}

export function faceCall(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> {
  const id = ++seq;
  return new Promise(res => { pending.set(id, res); getWorker().postMessage({ ...msg, id }, transfer); });
}

export function faceReady() {
  if (!readyPromise) {
    readyPromise = faceCall({ type: 'init' }).then(r => {
      if (r.type !== 'ready') { readyPromise = null; throw new Error(r.message || 'модели не загрузились'); }
    });
  }
  return readyPromise;
}

export const faceEngineStarted = () => readyPromise !== null;

/** Кадр или фото → пиксели для потока; крупные снимки уменьшаются. */
export function grabPixels(source: CanvasImageSource, w: number, h: number, maxSide = 960) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { buffer: img.data.buffer, width: c.width, height: c.height, scale: k };
}

/** Выровненное лицо 112×112 из потока → JPEG. */
export function thumbJpeg(buf: ArrayBuffer, quality = 0.9) {
  const rgb = new Uint8Array(buf);
  const c = document.createElement('canvas');
  c.width = 112; c.height = 112;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(112, 112);
  for (let i = 0; i < 112 * 112; i++) {
    img.data[i * 4] = rgb[i * 3]; img.data[i * 4 + 1] = rgb[i * 3 + 1]; img.data[i * 4 + 2] = rgb[i * 3 + 2]; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', quality);
}

/** Фото → отпечаток лица и миниатюра; фото никуда не отправляется. */
export async function enrollFromFile(file: File): Promise<{ ok: true; emb: number[]; thumb: string } | { ok: false; reason: string }> {
  await faceReady();
  const bmp = await createImageBitmap(file);
  const px = grabPixels(bmp, bmp.width, bmp.height, 1280);
  const r = await faceCall({ type: 'enroll', buffer: px.buffer, width: px.width, height: px.height }, [px.buffer]);
  if (r.type !== 'enrolled') return { ok: false, reason: r.reason || r.message || 'не удалось обработать фото' };
  return { ok: true, emb: r.emb as number[], thumb: thumbJpeg(r.thumb) };
}
