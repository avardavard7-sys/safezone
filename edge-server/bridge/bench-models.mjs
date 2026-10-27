// bench-models.mjs — замер моделей НА ТВОЕЙ МАШИНЕ (Фаза 1).
// Запуск:  node bench-models.mjs
// 1) Сравнивает детекторы: yolov8n vs yolox_nano vs yolox_s (латентность + что нашли)
// 2) Если рядом лежит rtmpose_m.onnx (после download-phase1-models) — меряет его
//    скорость на этом CPU. Полная интеграция RTMPose — следующим апдейтом,
//    когда цифры покажут что она того стоит.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import ort from 'onnxruntime-node';
import { letterbox } from './letterbox.js';

console.log('Качаю тестовое фото (4 человека)...');
const testPath = process.platform === 'win32' ? 'bench_test.jpg' : '/tmp/bench_test.jpg';
execSync(`curl -sL --max-time 30 -o ${testPath} https://raw.githubusercontent.com/ultralytics/ultralytics/main/ultralytics/assets/bus.jpg`);
const buf = await readFile(testPath);

async function benchDetector(name, detectFn, initFn) {
  await initFn();
  await detectFn(buf); // прогрев
  const times = [];
  let last;
  for (let i = 0; i < 8; i++) {
    const t0 = Date.now();
    last = await detectFn(buf);
    times.push(Date.now() - t0);
  }
  const avg = Math.round(times.reduce((a, b) => a + b) / times.length);
  const found = last.map(d => `${d.cls}:${(d.conf * 100) | 0}%`).join(', ');
  console.log(`${name.padEnd(24)} avg ${String(avg).padStart(4)}ms | ${found}`);
  return avg;
}

console.log('\n═══ ДЕТЕКТОРЫ (8 прогонов, прогретые) ═══');
const { detect: v8d, init: v8i } = await import('./yolo.js');
await benchDetector('yolov8n 640 (AGPL)', v8d, v8i);

const { createYolox } = await import('./yolox.js');
for (const [m, size] of [['yolox_nano', 416], ['yolox_s', 640]]) {
  if (!existsSync(`./${m}.onnx`)) { console.log(`${m}: файла нет, пропуск`); continue; }
  const yx = createYolox(`${m}.onnx`, size);
  await benchDetector(`${m} ${size} (Apache)`, yx.detect, yx.init);
}

console.log('\n═══ ПОЗЫ (вся сцена за проход) ═══');
const { poseDetect, poseInit } = await import('./pose.js');
await poseInit();
await poseDetect(buf);
{
  const times = [];
  let last;
  for (let i = 0; i < 8; i++) { const t0 = Date.now(); last = await poseDetect(buf); times.push(Date.now() - t0); }
  console.log(`yolov8n-pose 640 (AGPL)   avg ${String(Math.round(times.reduce((a,b)=>a+b)/times.length)).padStart(4)}ms | людей: ${last.persons.length}`);
}
if (existsSync('./rtmo_m.onnx')) {
  const { rtmoDetect, rtmoInit } = await import('./rtmo.js');
  await rtmoInit();
  await rtmoDetect(buf);
  const times = [];
  let last;
  for (let i = 0; i < 8; i++) { const t0 = Date.now(); last = await rtmoDetect(buf); times.push(Date.now() - t0); }
  console.log(`rtmo_m 640 (Apache)       avg ${String(Math.round(times.reduce((a,b)=>a+b)/times.length)).padStart(4)}ms | людей: ${last.persons.length}`);
  console.log('  → если rtmo_m укладывается в ~400ms на этой машине, ставь POSE_MODEL=rtmo_m');
}

if (existsSync('./rtmpose_m.onnx')) {
  // RTMPose — top-down: работает по КРОПУ одного человека 256x192.
  // Меряем чистую латентность инференса на этом CPU.
  const sess = await ort.InferenceSession.create('./rtmpose_m.onnx');
  const lb = await letterbox(buf, 256); // грубый вход для замера скорости
  // вход RTMPose 256x192 — подрежем тензор до нужной формы через отдельный препроцесс
  const sharp = (await import('sharp')).default;
  const { data } = await sharp(buf).resize(192, 256, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = 256 * 192;
  const chw = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { chw[i] = data[i*3]; chw[n+i] = data[i*3+1]; chw[2*n+i] = data[i*3+2]; }
  const tensor = new ort.Tensor('float32', chw, [1, 3, 256, 192]);
  await sess.run({ [sess.inputNames[0]]: tensor });
  const times = [];
  for (let i = 0; i < 8; i++) { const t0 = Date.now(); await sess.run({ [sess.inputNames[0]]: tensor }); times.push(Date.now() - t0); }
  const avg = Math.round(times.reduce((a,b)=>a+b)/times.length);
  console.log(`rtmpose_m 256x192 (Apache) avg ${avg}ms НА ОДНОГО человека (top-down: умножай на людей в кадре)`);
  console.log(`  формы выходов: ${sess.outputNames.map(o => o).join(', ')}`);
  console.log(`  → пришли мне эти цифры, и я приму решение по интеграции RTMPose.`);
} else {
  console.log('rtmpose_m.onnx не найден — сначала запусти download-phase1-models.ps1 (Windows) или .sh');
}
