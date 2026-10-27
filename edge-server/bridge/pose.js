// pose.js — скелеты 17 точек (yolov8n-pose.onnx) с letterbox-препроцессингом.
// v7: возвращает { persons, width, height, aspect } — координаты нормализованы
// к ИСХОДНОМУ кадру, aspect нужен для честной геометрии (лежит/стоит).
import ort from 'onnxruntime-node';
import path from 'path';
import { fileURLToPath } from 'url';
import { letterbox, unboxPoint, unboxRect } from './letterbox.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL = path.join(__dirname, 'yolov8n-pose.onnx');
const SIZE = 640;
let session = null;

export async function poseInit() {
  if (!session) session = await ort.InferenceSession.create(MODEL);
  return session;
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter + 1e-6);
}

export async function poseDetect(jpegBuffer, confThr = 0.4) {
  const sess = await poseInit();
  const lb = await letterbox(jpegBuffer, SIZE);
  const out = await sess.run({ [sess.inputNames[0]]: lb.tensor });
  const t = out[sess.outputNames[0]];
  const num = t.dims[2];
  const d = t.data;
  const cand = [];
  for (let i = 0; i < num; i++) {
    const conf = d[4 * num + i];
    if (conf < confThr) continue;
    const cx = d[i], cy = d[num + i], w = d[2 * num + i], h = d[3 * num + i];
    const kptsRaw = [];
    for (let k = 0; k < 17; k++) {
      kptsRaw.push({
        x: d[(5 + k * 3) * num + i],
        y: d[(5 + k * 3 + 1) * num + i],
        c: d[(5 + k * 3 + 2) * num + i],
      });
    }
    cand.push({ conf, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, kptsRaw });
  }
  cand.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const c of cand) {
    if (!keep.some(k => iou(k, c) > 0.5)) keep.push(c);
    if (keep.length >= 12) break;
  }
  const persons = keep.map(p => ({
    conf: p.conf,
    ...unboxRect(p.x1, p.y1, p.x2, p.y2, lb),
    kpts: p.kptsRaw.map(k => ({ ...unboxPoint(k.x, k.y, lb), c: k.c })),
  }));
  return { persons, width: lb.width, height: lb.height, aspect: lb.aspect };
}
