import { readFileSync, readdirSync, writeFileSync } from 'fs';
const [bridge, dir, out] = process.argv.slice(2);
const { rtmoInit, rtmoDetect } = await import(bridge + '/rtmo.js');
const { createYolox } = await import(bridge + '/yolox.js');
await rtmoInit(); const y = createYolox('yolox_s.onnx', 640); await y.init();
const res = [];
for (const f of readdirSync(dir).filter(x => x.endsWith('.jpg')).sort()) {
  const buf = readFileSync(dir + '/' + f);
  const p = await rtmoDetect(buf);
  const d = await y.detect(buf);
  res.push({ f, persons: p.persons, dets: d });
}
writeFileSync(out, JSON.stringify(res));
console.log(dir, res.length, 'кадров, людей в среднем', (res.reduce((a, r) => a + r.persons.length, 0) / res.length).toFixed(2));
