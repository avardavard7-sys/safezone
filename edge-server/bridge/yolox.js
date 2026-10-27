// yolox.js — альтернативный детектор YOLOX (Megvii, Apache-2.0) — кандидат на
// замену yolov8n (AGPL). Тот же COCO-80, та же сигнатура detect().
// Препроцессинг YOLOX: letterbox в ЛЕВЫЙ ВЕРХНИЙ угол, BGR, БЕЗ /255.
import ort from 'onnxruntime-node';
import path from 'path';
import { fileURLToPath } from 'url';
import { letterbox, unboxRect } from './letterbox.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COCO = ['person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair','couch','potted plant','bed','dining table','toilet','tv','laptop','mouse','remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush'];

const WATCH = {
  person: 0.35,
  knife: 0.25, scissors: 0.25, fork: 0.30, 'baseball bat': 0.30,
  backpack: 0.45, handbag: 0.45, suitcase: 0.45,
  bottle: 0.50, 'cell phone': 0.40,
  // посуда для сценариев кофейни/ресторана (зоны: «убрать со стола»)
  cup: 0.35, bowl: 0.35, 'wine glass': 0.35, spoon: 0.30,
  car: 0.45, truck: 0.45, motorcycle: 0.45,
};

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / ((a.x2-a.x1)*(a.y2-a.y1) + (b.x2-b.x1)*(b.y2-b.y1) - inter + 1e-6);
}
function nms(boxes, thr = 0.45) {
  boxes.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const b of boxes) if (!keep.some(k => k.cls === b.cls && iou(k, b) > thr)) keep.push(b);
  return keep;
}

export function createYolox(modelFile, size) {
  let session = null;
  let grids = null; // предрасчёт сеток для strides 8/16/32

  function buildGrids() {
    grids = [];
    for (const s of [8, 16, 32]) {
      const g = size / s;
      for (let y = 0; y < g; y++) for (let x = 0; x < g; x++) grids.push({ gx: x, gy: y, stride: s });
    }
  }

  async function init() {
    if (!session) {
      session = await ort.InferenceSession.create(path.join(__dirname, modelFile));
      buildGrids();
    }
    return session;
  }

  async function detect(jpegBuffer) {
    const sess = await init();
    const lb = await letterbox(jpegBuffer, size, { scale01: false, bgr: true, topLeft: true });
    const out = await sess.run({ [sess.inputNames[0]]: lb.tensor });
    const t = out[sess.outputNames[0]];
    const [, num, ch] = t.dims; // [1, N, 85]
    const d = t.data;
    const nc = ch - 5;
    const boxes = [];
    for (let i = 0; i < num; i++) {
      const base = i * ch;
      const obj = d[base + 4];
      if (obj < 0.1) continue;
      let best = 0, bestC = -1;
      for (let c = 0; c < nc; c++) {
        const s = d[base + 5 + c];
        if (s > best) { best = s; bestC = c; }
      }
      const conf = obj * best;
      const name = COCO[bestC];
      const need = WATCH[name];
      if (need === undefined || conf < need) continue;
      const g = grids[i];
      const cx = (d[base] + g.gx) * g.stride;
      const cy = (d[base + 1] + g.gy) * g.stride;
      const w = Math.exp(d[base + 2]) * g.stride;
      const h = Math.exp(d[base + 3]) * g.stride;
      boxes.push({ cls: name, conf, x1: cx - w/2, y1: cy - h/2, x2: cx + w/2, y2: cy + h/2 });
    }
    const kept = nms(boxes);
    return kept.map(b => ({ cls: b.cls, conf: b.conf, ...unboxRect(b.x1, b.y1, b.x2, b.y2, lb) }));
  }

  return { detect, init };
}
