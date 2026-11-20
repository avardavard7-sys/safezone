import { readFileSync } from 'fs';
import { createRequire } from 'module';
const [bridge, dir, json, lineJson, fps = '5', stride = '1'] = process.argv.slice(2);
const sharp = createRequire(bridge + '/index.js')('sharp');
const { CameraTracker } = await import(bridge + '/tracker.js');
const { LineCounter } = await import(bridge + '/counter.js');
const { MotionCounter, CountFusion } = await import(bridge + '/motioncount.js');
let frames = JSON.parse(readFileSync(json)).filter((_, i) => i % +stride === 0);
const G = process.env.FLICKER, NZ = +process.env.NOISE || 0;
const load = async (f, i) => { const b = readFileSync(`${dir}/${f}`); if (!G && !NZ) return b; let im = sharp(b); if (G) im = im.linear(i % 40 < 20 ? 1 : +G, 0); if (NZ) { const { width, height } = await sharp(b).metadata(); const n = Buffer.alloc(width * height * 3); for (let k = 0; k < n.length; k++) n[k] = 128 + (Math.random() - 0.5) * 2 * NZ; im = im.composite([{ input: await sharp(n, { raw: { width, height, channels: 3 } }).png().toBuffer(), blend: 'soft-light' }]); } return im.jpeg({ quality: 80 }).toBuffer(); };
const line = { id: 'l', inside: 'left', ...JSON.parse(lineJson) };
const tr = new CameraTracker({ ttlMs: 5000 }), lc = new LineCounter({ lines: [line] }), mc = new MotionCounter({ lines: [line] }), fu = new CountFusion({ lines: [line] });
const cnt = { det: [0, 0], mot: [0, 0], fused: [0, 0], extra: [] }; let t = 1e6, i = 0;
const add = (k, e) => cnt[k][e.direction === 'in' ? 0 : 1]++;
const dt = 1000 / +fps;
for (const fr of [...frames, ...Array(Math.ceil(3000 / dt)).fill(null)]) { t += dt;
  const tracks = fr ? tr.update(fr.dets.map(d => ({ ...d })), t) : [];
  const de = fr ? lc.observe(tracks, t) : [];
  if (fr) mc.learnSize(fr.dets);
  const me = fr ? await mc.observe(await load(fr.f, i++), t, fr.dets) : [];
  de.forEach(e => add('det', e)); me.forEach(e => add('mot', e));
  for (const e of fu.push(de, tracks, me, t)) { add('fused', e); if (e.source === "motion") cnt.extra.push(`${((e.at - 1e6) / 1000).toFixed(1)}с ${e.direction} pos${e.pos.toFixed(2)}`); else if (process.env.V) console.log("det", ((e.at-1e6)/1000).toFixed(1), e.direction); }
}
console.log(`детектор ${cnt.det} | движение ${cnt.mot} | вместе ${cnt.fused} (всего ${cnt.fused[0] + cnt.fused[1]}) | добавлено движением: ${cnt.extra.join(', ') || 'нет'}`);
