import { readFileSync } from 'fs';
const [bridge, fdir, json, name, polys] = process.argv.slice(2);
const { ShelfChange } = await import(bridge + '/shelfchange.js');
const { CameraTracker } = await import(bridge + '/tracker.js');
const regions = JSON.parse(polys).map((p, i) => ({ id: 's' + i, kind: 'shelf', name: 'Полка ' + (i + 1), points: p }));
const sc = new ShelfChange({ regions }); const tr = new CameraTracker({ ttlMs: 5000 });
const frames = JSON.parse(readFileSync(json)); let t = 1e6, ms = 0; const picks = [], alerts = [];
for (const fr of frames) {
  t += 1000 / 6;
  const tracks = tr.update(fr.persons.map(p => ({ ...p, cls: 'person' })), t);
  const bags = fr.dets.filter(d => ['backpack', 'handbag', 'suitcase'].includes(d.cls));
  const s = Date.now(); const r = await sc.observe(readFileSync(fdir + '/' + fr.f), tracks, t, { bags }); ms += Date.now() - s;
  for (const p of r.picks) picks.push(`${((t - 1e6) / 1000).toFixed(1)}с (${p.cx.toFixed(2)},${p.cy.toFixed(2)})`);
  for (const a of r.alerts) alerts.push(`${((a.at - 1e6) / 1000).toFixed(1)}с → ${a.where === 'bag' ? 'в сумку' : 'к телу'}`);
}
console.log(`${name}: взято с полки ${picks.length} [${picks.join(', ')}] | тревоги ${alerts.length} [${alerts.join(', ')}] | ${(ms / frames.length).toFixed(0)} мс/кадр`);
