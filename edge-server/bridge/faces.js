/**
 * Лица: поиск (YuNet, MIT) и отпечаток из 128 чисел (SFace, Apache-2.0).
 * Обе модели — оригиналы OpenCV Zoo.
 *
 * Отпечатки лиц посетителей нигде не сохраняются: считаются в памяти,
 * сравниваются со списком и сразу выбрасываются.
 */
import ort from 'onnxruntime-node';
import sharp from 'sharp';

const SIZE = 640;
const STRIDES = [8, 16, 32];
// эталонные положения 5 точек лица в кадре 112×112 (глаза, нос, углы рта)
const REF = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

let det = null;
let rec = null;

export async function facesInit(dir = '.') {
  const opts = { logSeverityLevel: 3 };
  det = await ort.InferenceSession.create(`${dir}/face_detection_yunet_2023mar.onnx`, opts);
  rec = await ort.InferenceSession.create(`${dir}/face_recognition_sface_2021dec.onnx`, opts);
}
export const facesReady = () => Boolean(det && rec);

export async function decodeImage(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const iou = (a, b) => {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const i = w * h;
  return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i || 1);
};

/** Лица в пикселях исходного кадра: рамка, уверенность, 5 точек. */
export async function detectFaces(img, scoreThr = 0.75) {
  const s = Math.min(SIZE / img.width, SIZE / img.height);
  const rw = Math.round(img.width * s), rh = Math.round(img.height * s);
  const small = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .resize(rw, rh).raw().toBuffer();

  // модель ждёт BGR без нормировки, 0..255
  const area = SIZE * SIZE;
  const t = new Float32Array(3 * area);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 3, o = y * SIZE + x;
      t[o] = small[i + 2]; t[area + o] = small[i + 1]; t[2 * area + o] = small[i];
    }
  }
  const out = await det.run({ input: new ort.Tensor('float32', t, [1, 3, SIZE, SIZE]) });

  const found = [];
  for (const st of STRIDES) {
    const cols = SIZE / st, rows = SIZE / st;
    const cls = out[`cls_${st}`].data, obj = out[`obj_${st}`].data;
    const box = out[`bbox_${st}`].data, kps = out[`kps_${st}`].data;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const clamp = v => Math.min(1, Math.max(0, v));
        const score = Math.sqrt(clamp(cls[i]) * clamp(obj[i]));
        if (score < scoreThr) continue;
        const cx = (c + box[i * 4]) * st, cy = (r + box[i * 4 + 1]) * st;
        const w = Math.exp(box[i * 4 + 2]) * st, h = Math.exp(box[i * 4 + 3]) * st;
        const lm = [];
        for (let k = 0; k < 5; k++) lm.push([((c + kps[i * 10 + 2 * k]) * st) / s, ((r + kps[i * 10 + 2 * k + 1]) * st) / s]);
        found.push({ x1: (cx - w / 2) / s, y1: (cy - h / 2) / s, x2: (cx + w / 2) / s, y2: (cy + h / 2) / s, score, lm });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of found) if (kept.every(k => iou(k, f) < 0.3)) kept.push(f);
  return kept;
}

/** Подобие (поворот, масштаб, сдвиг) по методу наименьших квадратов: точки лица → эталон. */
export function similarity(src, dst) {
  const n = src.length;
  const ms = [0, 0], md = [0, 0];
  for (let i = 0; i < n; i++) { ms[0] += src[i][0] / n; ms[1] += src[i][1] / n; md[0] += dst[i][0] / n; md[1] += dst[i][1] / n; }
  let na = 0, nb = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - ms[0], sy = src[i][1] - ms[1];
    const dx = dst[i][0] - md[0], dy = dst[i][1] - md[1];
    na += sx * dx + sy * dy; nb += sx * dy - sy * dx; den += sx * sx + sy * sy;
  }
  const a = na / den, b = nb / den;
  return { a, b, tx: md[0] - (a * ms[0] - b * ms[1]), ty: md[1] - (b * ms[0] + a * ms[1]) };
}

/** Выровненное лицо 112×112, RGB, билинейная выборка из исходного кадра. */
export function alignFace(img, lm) {
  const { a, b, tx, ty } = similarity(lm, REF);
  const k = 1 / (a * a + b * b);
  const out = Buffer.alloc(112 * 112 * 3);
  for (let v = 0; v < 112; v++) {
    for (let u = 0; u < 112; u++) {
      const px = u - tx, py = v - ty;
      const x = k * (a * px + b * py), y = k * (-b * px + a * py);
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      for (let ch = 0; ch < 3; ch++) {
        const p = (xx, yy) => (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height ? 0 : img.data[(yy * img.width + xx) * 3 + ch]);
        const val = p(x0, y0) * (1 - fx) * (1 - fy) + p(x0 + 1, y0) * fx * (1 - fy) + p(x0, y0 + 1) * (1 - fx) * fy + p(x0 + 1, y0 + 1) * fx * fy;
        out[(v * 112 + u) * 3 + ch] = Math.round(val);
      }
    }
  }
  return out;
}

/** Отпечаток лица: 128 чисел единичной длины — сравнение скалярным произведением. */
export async function embedFace(aligned) {
  const area = 112 * 112;
  const t = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    t[i] = aligned[i * 3]; t[area + i] = aligned[i * 3 + 1]; t[2 * area + i] = aligned[i * 3 + 2];
  }
  const out = await rec.run({ data: new ort.Tensor('float32', t, [1, 3, 112, 112]) });
  const e = Float32Array.from(out.fc1.data);
  const norm = Math.hypot(...e) || 1;
  return e.map(v => v / norm);
}

export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

export async function alignedJpeg(aligned, size = 160) {
  return sharp(aligned, { raw: { width: 112, height: 112, channels: 3 } }).resize(size, size).jpeg({ quality: 88 }).toBuffer();
}
