import { readFileSync } from 'fs';
const [bridge, json, name, polys] = process.argv.slice(2);
const { CameraTracker } = await import(bridge + '/tracker.js');
const { ShelfWatch } = await import(bridge + '/shelf.js');
const regions = JSON.parse(polys).map((p, i) => ({ id: 's' + i, kind: 'shelf', name: 'Полка ' + (i + 1), points: p }));
for (const torso of [false, true]) {
  const tr = new CameraTracker({ ttlMs: 5000 }); const sw = new ShelfWatch({ regions, torso });
  const frames = JSON.parse(readFileSync(json)); let t = 1e6; const alerts = []; let reach = 0;
  for (const fr of frames) { t += 167; const tracks = tr.update(fr.persons.map(p => ({ ...p, cls: 'person' })), t);
    for (const a of sw.observe(tracks, t)) alerts.push(`${((t - 1e6) / 1000).toFixed(1)}с ${a.spot}`);
    for (const st of sw.state.values()) for (const h of Object.values(st.hands)) if (h.touch && h.touch.at === t) reach++; }
  console.log(name, torso ? '[с правилом «под одежду»]' : '[как сейчас в продукте]', '| кадров с рукой у полки:', reach, '| тревоги:', alerts.length ? alerts.join(', ') : 'нет');
}
