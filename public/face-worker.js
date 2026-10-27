/* SafeZone — распознавание лиц в фоновом потоке.
 * Модели и расчёты работают здесь, а не в потоке страницы — поэтому страница
 * не замирает, сколько бы ни длился кадр. Те же модели и алгоритм, что в бридже.
 * Отпечатки лиц с камеры не покидают этот поток: наружу уходят только рамки,
 * имя из списка и процент сходства. */
'use strict';

var SIZE = 640;
var STRIDES = [8, 16, 32];
var REF = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
var det = null, rec = null, refs = [], queue = Promise.resolve();

function letterbox(px, w, h) {
  var s = Math.min(SIZE / w, SIZE / h), rw = Math.round(w * s), rh = Math.round(h * s);
  var area = SIZE * SIZE, t = new Float32Array(3 * area), sx = w / rw, sy = h / rh;
  for (var y = 0; y < rh; y++) {
    var fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
    var y0 = fy | 0, y1 = y0 + 1 < h ? y0 + 1 : y0, wy = fy - y0;
    for (var x = 0; x < rw; x++) {
      var fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
      var x0 = fx | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, wx = fx - x0;
      var i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4, i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      var a = (1 - wx) * (1 - wy), b = wx * (1 - wy), c = (1 - wx) * wy, d = wx * wy, o = y * SIZE + x;
      t[o] = px[i00 + 2] * a + px[i01 + 2] * b + px[i10 + 2] * c + px[i11 + 2] * d;
      t[area + o] = px[i00 + 1] * a + px[i01 + 1] * b + px[i10 + 1] * c + px[i11 + 1] * d;
      t[2 * area + o] = px[i00] * a + px[i01] * b + px[i10] * c + px[i11] * d;
    }
  }
  return { tensor: t, scale: s };
}

function iou(a, b) {
  var w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  var h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  var i = w * h;
  return i / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i || 1);
}

function decode(out, s, thr) {
  var found = [];
  for (var k = 0; k < STRIDES.length; k++) {
    var st = STRIDES[k], cols = SIZE / st, rows = SIZE / st;
    var cls = out['cls_' + st].data, obj = out['obj_' + st].data, box = out['bbox_' + st].data, kps = out['kps_' + st].data;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c;
        var cv = Math.min(1, Math.max(0, cls[i])), ov = Math.min(1, Math.max(0, obj[i]));
        var score = Math.sqrt(cv * ov);
        if (score < thr) continue;
        var cx = (c + box[i * 4]) * st, cy = (r + box[i * 4 + 1]) * st;
        var bw = Math.exp(box[i * 4 + 2]) * st, bh = Math.exp(box[i * 4 + 3]) * st;
        var lm = [];
        for (var p = 0; p < 5; p++) lm.push([((c + kps[i * 10 + 2 * p]) * st) / s, ((r + kps[i * 10 + 2 * p + 1]) * st) / s]);
        found.push({ x1: (cx - bw / 2) / s, y1: (cy - bh / 2) / s, x2: (cx + bw / 2) / s, y2: (cy + bh / 2) / s, score: score, lm: lm });
      }
    }
  }
  found.sort(function (a, b) { return b.score - a.score; });
  var kept = [];
  for (var j = 0; j < found.length; j++) {
    var ok = true;
    for (var q = 0; q < kept.length; q++) if (iou(kept[q], found[j]) >= 0.3) { ok = false; break; }
    if (ok) kept.push(found[j]);
  }
  return kept;
}

function pix(px, w, h, x, y, ch) {
  return x < 0 || y < 0 || x >= w || y >= h ? 0 : px[(y * w + x) * 4 + ch];
}

function align(px, w, h, lm) {
  var ms = [0, 0], md = [0, 0], i;
  for (i = 0; i < 5; i++) { ms[0] += lm[i][0] / 5; ms[1] += lm[i][1] / 5; md[0] += REF[i][0] / 5; md[1] += REF[i][1] / 5; }
  var na = 0, nb = 0, den = 0;
  for (i = 0; i < 5; i++) {
    var sx = lm[i][0] - ms[0], sy = lm[i][1] - ms[1], dx = REF[i][0] - md[0], dy = REF[i][1] - md[1];
    na += sx * dx + sy * dy; nb += sx * dy - sy * dx; den += sx * sx + sy * sy;
  }
  var a = na / den, b = nb / den, tx = md[0] - (a * ms[0] - b * ms[1]), ty = md[1] - (b * ms[0] + a * ms[1]);
  var k = 1 / (a * a + b * b), out = new Uint8Array(112 * 112 * 3);
  for (var v = 0; v < 112; v++) {
    for (var u = 0; u < 112; u++) {
      var px0 = u - tx, py0 = v - ty;
      var x = k * (a * px0 + b * py0), y = k * (-b * px0 + a * py0);
      var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      for (var ch = 0; ch < 3; ch++) {
        var val = pix(px, w, h, x0, y0, ch) * (1 - fx) * (1 - fy) + pix(px, w, h, x0 + 1, y0, ch) * fx * (1 - fy)
          + pix(px, w, h, x0, y0 + 1, ch) * (1 - fx) * fy + pix(px, w, h, x0 + 1, y0 + 1, ch) * fx * fy;
        out[(v * 112 + u) * 3 + ch] = Math.round(val);
      }
    }
  }
  return out;
}

async function embed(px, w, h, lm) {
  var aligned = align(px, w, h, lm), area = 112 * 112, t = new Float32Array(3 * area);
  for (var i = 0; i < area; i++) { t[i] = aligned[i * 3]; t[area + i] = aligned[i * 3 + 1]; t[2 * area + i] = aligned[i * 3 + 2]; }
  var out = await rec.run({ data: new self.ort.Tensor('float32', t, [1, 3, 112, 112]) });
  var e = out.fc1.data, n = 0;
  for (i = 0; i < e.length; i++) n += e[i] * e[i];
  n = Math.sqrt(n) || 1;
  var emb = new Float32Array(e.length);
  for (i = 0; i < e.length; i++) emb[i] = e[i] / n;
  return { emb: emb, aligned: aligned };
}

async function detect(px, w, h, thr) {
  var lb = letterbox(px, w, h);
  var out = await det.run({ input: new self.ort.Tensor('float32', lb.tensor, [1, 3, SIZE, SIZE]) });
  return decode(out, lb.scale, thr);
}

async function init(m) {
  if (det && rec) return;
  if (!self.ort) self.importScripts((m.ortBase || '/ort/') + 'ort.wasm.min.js');
  self.ort.env.wasm.wasmPaths = m.ortBase || '/ort/';
  self.ort.env.wasm.numThreads = 1;
  self.ort.env.logLevel = 'error';
  // 3 = только ошибки: иначе ядро печатает в консоль ~300 безвредных предупреждений о весах модели
  var opts = { executionProviders: ['wasm'], logSeverityLevel: 3 };
  var base = m.base || '/models';
  det = await self.ort.InferenceSession.create(m.models ? new Uint8Array(m.models.det) : base + '/face_detection_yunet_2023mar.onnx', opts);
  rec = await self.ort.InferenceSession.create(m.models ? new Uint8Array(m.models.rec) : base + '/face_recognition_sface_2021dec.onnx', opts);
}

async function handle(m) {
  if (m.type === 'init') { await init(m); self.postMessage({ type: 'ready', id: m.id }); return; }
  if (!det || !rec) await init({});

  if (m.type === 'refs') {
    refs = (m.refs || []).filter(function (r) { return r.emb && r.emb.length === 128; })
      .map(function (r) { return { label: r.label, emb: Float32Array.from(r.emb) }; });
    self.postMessage({ type: 'refs', id: m.id, count: refs.length });
    return;
  }

  var px = new Uint8ClampedArray(m.buffer), w = m.width, h = m.height, t0 = Date.now();

  if (m.type === 'enroll') {
    var fs = (await detect(px, w, h, 0.6)).sort(function (a, b) { return (b.x2 - b.x1) - (a.x2 - a.x1); });
    if (!fs.length) { self.postMessage({ type: 'enroll-fail', id: m.id, reason: 'лицо не найдено' }); return; }
    if (fs[0].x2 - fs[0].x1 < 80) { self.postMessage({ type: 'enroll-fail', id: m.id, reason: 'лицо слишком мелкое — нужно крупнее' }); return; }
    var r = await embed(px, w, h, fs[0].lm);
    self.postMessage({ type: 'enrolled', id: m.id, emb: Array.from(r.emb), thumb: r.aligned.buffer }, [r.aligned.buffer]);
    return;
  }

  if (m.type === 'frame') {
    var faces = await detect(px, w, h, 0.75), res = [];
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i], box = { x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2 }, width = f.x2 - f.x1;
      if (width < (m.minFace || 60)) { res.push({ box: box, small: true, width: Math.round(width) }); continue; }
      if (!refs.length) { res.push({ box: box, best: null }); continue; }
      var e = (await embed(px, w, h, f.lm)).emb, best = null;
      for (var j = 0; j < refs.length; j++) {
        var s = 0, re = refs[j].emb;
        for (var q = 0; q < 128; q++) s += e[q] * re[q];
        if (!best || s > best.score) best = { label: refs[j].label, score: s };
      }
      res.push({ box: box, best: best });
    }
    self.postMessage({ type: 'faces', id: m.id, faces: res, ms: Date.now() - t0 });
  }
}

self.onmessage = function (ev) {
  var m = ev.data;
  // по одному запросу за раз: модели не любят параллельных вызовов
  queue = queue.then(function () { return handle(m); }).catch(function (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  });
};
