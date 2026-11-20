import { readFileSync, readdirSync, writeFileSync } from 'fs';
const [bridge, dir, out, model = 'yolox_s.onnx'] = process.argv.slice(2);
const { createYolox } = await import(bridge + '/yolox.js');
const y = createYolox(model, 640); await y.init();
const res = []; const t0 = Date.now();
for (const f of readdirSync(dir).filter(x => x.endsWith('.jpg')).sort()) res.push({ f, dets: (await y.detect(readFileSync(dir + '/' + f))).filter(d => d.cls === 'person') });
writeFileSync(out, JSON.stringify(res));
console.log(dir, model, res.length, 'кадров', ((Date.now() - t0) / res.length | 0), 'мс/кадр, людей в среднем', (res.reduce((a, r) => a + r.dets.length, 0) / res.length).toFixed(2));
