import { readFileSync } from 'fs';
const [bridge, dir, poseJson, drawerPoly, customerPoly, seedFrame = '0', fps = '5'] = process.argv.slice(2);
const { CameraTracker } = await import(bridge + '/tracker.js');
const { DrawerWatch } = await import(bridge + '/drawerwatch.js');
const { decodeGray } = await import(bridge + '/shelfchange.js');
let frames = JSON.parse(readFileSync(poseJson));
if (process.env.REVERSE) frames = frames.reverse();
const { createRequire } = await import('module');
const sharp = createRequire(bridge + '/index.js')('sharp');
const G = +process.env.GAIN || 1, NZ = +process.env.NOISE || 0;
const load = async f => { const b = readFileSync(`${dir}/${f}`); if (G === 1 && !NZ) return b; let im = sharp(b).linear(G, 0); if (NZ) { const { width, height } = await sharp(b).metadata(); const n = Buffer.alloc(width * height * 3); for (let i = 0; i < n.length; i++) n[i] = 128 + (Math.random() - 0.5) * 2 * NZ; im = im.composite([{ input: await sharp(n, { raw: { width, height, channels: 3 } }).png().toBuffer(), blend: 'soft-light' }]); } return im.jpeg({ quality: 80 }).toBuffer(); };
const regions = [{ id: 'd', kind: 'cash_drawer', name: 'Касса', points: JSON.parse(drawerPoly) }];
if (customerPoly && customerPoly !== '-') regions.push({ id: 'c', kind: 'cash_customer', points: JSON.parse(customerPoly) });
const w = new DrawerWatch({ regions });
const tr = new CameraTracker({ ttlMs: 5000 });
if (+seedFrame) w.calibrate(await decodeGray(readFileSync(`${dir}/${String(seedFrame).padStart(4, "0")}.jpg`)));
const step = 1000 / +fps; let t = 1e6;
for (const fr of frames) {
  t += step;
  const tracks = tr.update(fr.persons.map(p => ({ ...p, cls: 'person' })), t).filter(x => x.lastSeen === t);
  const r = await w.observe(await load(fr.f), tracks, t);
  const s = ((t - 1e6) / 1000).toFixed(1);
  for (const e of r.events) console.log(`${s}с ${e.kind === 'open' ? 'ящик ОТКРЫТ' : e.kind === 'close' ? `ящик ЗАКРЫТ, был открыт ${(e.openMs / 1000).toFixed(1)} с` : 'эталон обновлён'}`);
  for (const a of r.alerts) {
    console.log(`${s}с ТРЕВОГА ${a.kind}`);
    if (process.env.OUT) { const { drawerEvidence } = await import(bridge + '/drawerwatch.js'); (await import('fs')).writeFileSync(`${process.env.OUT}/${a.kind}.jpg`, await drawerEvidence(a, await load(fr.f))); }
  }
  if (process.env.TRACE) console.log(s, w.drawers[0].frac.toFixed(2), w.drawers[0].visible.toFixed(2), w.drawers[0].seed, !!w.drawers[0].ref);
}
