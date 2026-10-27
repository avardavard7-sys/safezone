// yolo.js — детектор объектов (yolov8n.onnx, COCO-80) с letterbox-препроцессингом.
// v7: боксы возвращаются НОРМАЛИЗОВАННЫМИ (0..1) к ИСХОДНОМУ кадру — их ест трекер.
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';
import { letterbox, unboxRect } from './letterbox.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL_PATH = path.join(__dirname, 'yolov8n.onnx');
const SIZE = 640;

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

let session = null;
async function init() {
  if (!session) session = await ort.InferenceSession.create(MODEL_PATH);
  return session;
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter + 1e-6);
}

function nms(boxes, thr = 0.45) {
  boxes.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const b of boxes) {
    if (!keep.some(k => k.cls === b.cls && iou(k, b) > thr)) keep.push(b);
  }
  return keep;
}

async function detect(jpegBuffer) {
  const sess = await init();
  const lb = await letterbox(jpegBuffer, SIZE);
  const out = await sess.run({ [sess.inputNames[0]]: lb.tensor });
  const t = out[sess.outputNames[0]];
  const [, ch, num] = t.dims;
  const d = t.data;
  const nc = ch - 4;
  const boxes = [];
  for (let i = 0; i < num; i++) {
    let best = 0, bestC = -1;
    for (let c = 0; c < nc; c++) {
      const s = d[(4 + c) * num + i];
      if (s > best) { best = s; bestC = c; }
    }
    const name = COCO[bestC];
    const need = WATCH[name];
    if (need === undefined || best < need) continue;
    const cx = d[i], cy = d[num + i], w = d[2 * num + i], h = d[3 * num + i];
    // NMS считаем в пространстве letterbox (тут пропорции честные)
    boxes.push({ cls: name, conf: best, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 });
  }
  const kept = nms(boxes);
  // Возвращаем в нормализованных координатах исходного кадра
  return kept.map(b => ({ cls: b.cls, conf: b.conf, ...unboxRect(b.x1, b.y1, b.x2, b.y2, lb) }));
}

async function fireHint(jpegBuffer) {
  const { data } = await sharp(jpegBuffer)
    .resize(160, 160, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let firePix = 0;
  const total = 160 * 160;
  for (let i = 0; i < total; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    if (r > 200 && g > 90 && g < 200 && b < 110 && r - b > 110) firePix++;
  }
  return firePix / total;
}

export { detect, fireHint, init };
