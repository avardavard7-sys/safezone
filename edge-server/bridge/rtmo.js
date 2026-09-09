// rtmo.js — RTMO-m (mmpose, Apache-2.0): one-stage мультиперсонная поза.
// Кандидат на замену yolov8n-pose (AGPL). Вся сцена за ОДИН проход, без кропов.
// Препроцессинг (по спецификации rtmlib, Apache): letterbox в левый верхний
// угол, паддинг 114, BGR, БЕЗ нормализации. Выходы уже в пикселях входа,
// NMS зашит в модель.
import ort from 'onnxruntime-node';
import path from 'path';
import { fileURLToPath } from 'url';
import { letterbox, unboxPoint, unboxRect } from './letterbox.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL = path.join(__dirname, 'rtmo_m.onnx');
const SIZE = 640;
const SCORE_THR = 0.5;   // det score RTMO хорошо калиброван (rtmlib default 0.7)
let session = null;

export async function rtmoInit() {
  if (!session) session = await ort.InferenceSession.create(MODEL);
  return session;
}

export async function rtmoDetect(jpegBuffer, confThr = SCORE_THR) {
  const sess = await rtmoInit();
  const lb = await letterbox(jpegBuffer, SIZE, { scale01: false, bgr: true, topLeft: true });
  const out = await sess.run({ [sess.inputNames[0]]: lb.tensor });
  const dets = out['dets'];        // [1, N, 5]  x1,y1,x2,y2,score (пиксели входа)
  const kpts = out['keypoints'];   // [1, N, 17, 3]  x,y,conf
  const N = dets.dims[1];
  const dd = dets.data, kd = kpts.data;

  const persons = [];
  for (let i = 0; i < N; i++) {
    const score = dd[i * 5 + 4];
    if (score < confThr) continue;
    const box = unboxRect(dd[i * 5], dd[i * 5 + 1], dd[i * 5 + 2], dd[i * 5 + 3], lb);
    const kp = [];
    for (let k = 0; k < 17; k++) {
      const o = (i * 17 + k) * 3;
      kp.push({ ...unboxPoint(kd[o], kd[o + 1], lb), c: kd[o + 2] });
    }
    persons.push({ conf: score, ...box, kpts: kp });
    if (persons.length >= 12) break;
  }
  return { persons, width: lb.width, height: lb.height, aspect: lb.aspect };
}
