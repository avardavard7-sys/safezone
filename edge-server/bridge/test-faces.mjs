import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import sharp from 'sharp';
import { facesInit, decodeImage, detectFaces, alignFace, embedFace, cosine, alignedJpeg } from './faces.js';
import { BlacklistMatcher } from './blacklist.js';

let passed = 0, failed = 0; const out = [];
const t = async (n, f) => { try { await f(); passed++; out.push(`  ok   ${n}`); } catch (e) { failed++; out.push(`  FAIL ${n}\n         ${e.message}`); } };
const yes = (c, m) => { if (!c) throw new Error(m || 'не выполнено'); };

import { astronaut, twoPeople, smallFace } from './test-assets/images.mjs';
const IMAGES = { pair: twoPeople(), single: astronaut(), small: await smallFace() };
const buf = k => IMAGES[k];

await facesInit('.');
async function faceEmb(b, pick = fs => fs[0]) {
  const img = await decodeImage(b);
  const fs = (await detectFaces(img)).sort((a, z) => (z.x2 - z.x1) - (a.x2 - a.x1));
  if (!fs.length) return null;
  const f = pick(fs);
  return { emb: await embedFace(alignFace(img, f.lm)), width: f.x2 - f.x1, aligned: alignFace(img, f.lm) };
}

console.log('\n=== Чёрный список: настоящие модели, настоящие лица ===\n');

await t('находит оба лица на фото двоих и одно у астронавта', async () => {
  const z = await detectFaces(await decodeImage(buf('pair')));
  const l = await detectFaces(await decodeImage(buf('single')));
  yes(z.length === 2 && l.length === 1, `нашлось ${z.length} и ${l.length}`);
});
await t('пять точек лица внутри рамки лица', async () => {
  for (const f of await detectFaces(await decodeImage(buf('pair')))) {
    yes(f.lm.every(([x, y]) => x >= f.x1 - 5 && x <= f.x2 + 5 && y >= f.y1 - 5 && y <= f.y2 + 5), 'точка вне лица');
  }
});

const single = await faceEmb(buf('single'));
const variants = {
  'темнее': await sharp(buf('single')).modulate({ brightness: 0.7 }).jpeg().toBuffer(),
  'зеркально': await sharp(buf('single')).flop().jpeg().toBuffer(),
  'сильное сжатие': await sharp(buf('single')).jpeg({ quality: 30 }).toBuffer(),
};
for (const [name, b] of Object.entries(variants)) {
  await t(`тот же человек (${name}) — выше порога 0.45`, async () => {
    const s = cosine(single.emb, (await faceEmb(b)).emb);
    yes(s >= 0.45, `сходство ${s.toFixed(2)}`);
  });
}
await t('разные люди — ниже порога 0.45', async () => {
  const people = [single, await faceEmb(buf('pair'), fs => fs[0]), await faceEmb(buf('pair'), fs => fs[1])];
  for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
    const s = cosine(people[i].emb, people[j].emb);
    yes(s < 0.45, `пара ${i}-${j}: ${s.toFixed(2)}`);
  }
});

await t('полный путь: внесли по фото → появился темнее → совпадение', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e1', label: 'Тест', embedding: Array.from(single.emb), thumb: (await alignedJpeg(single.aligned)).toString('base64') }]);
  const seen = await faceEmb(variants['темнее']);
  const hit = m.match(seen.emb, seen.width, 1000);
  yes(hit && hit.entry.label === 'Тест', 'совпадения нет');
});
await t('посторонние люди при том же списке — тишина', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e1', label: 'Тест', embedding: Array.from(single.emb) }]);
  for (const k of [0, 1]) {
    const p = await faceEmb(buf('pair'), fs => fs[k]);
    yes(m.match(p.emb, p.width, 1000) === null, 'ложное совпадение');
  }
});
await t('мелкое лицо (около 30 px) не сравнивается даже с самим собой', async () => {
  const tiny = await faceEmb(buf('small'));
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e2', label: 'Далеко', embedding: Array.from(tiny.emb) }]);
  yes(tiny.width < 60, `ширина ${tiny.width}`);
  yes(m.match(tiny.emb, tiny.width, 1000) === null, 'мелкое лицо дало совпадение');
});
await t('одно совпадение — одна тревога за 10 минут', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e1', label: 'Тест', embedding: Array.from(single.emb) }]);
  const n = [0, 1000, 60_000, 11 * 60_000].filter(at => m.match(single.emb, 140, at)).length;
  yes(n === 2, `тревог ${n}`);
});
await t('лица посетителей нигде не остаются: в памяти только список и время тревог', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e1', label: 'Тест', embedding: Array.from(single.emb) }]);
  for (const k of [0, 1]) { const p = await faceEmb(buf('pair'), fs => fs[k]); m.match(p.emb, p.width, 1000); }
  yes(m.entries.length === 1 && m.lastAlert.size === 0, 'в памяти что-то лишнее');
});
await t('битые записи списка отбрасываются', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'x', embedding: [1, 2, 3] }, { id: 'y', embedding: null }, { id: 'z', embedding: Array.from(single.emb) }]);
  yes(m.size === 1, `записей ${m.size}`);
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
process.exit(failed ? 1 : 0);
