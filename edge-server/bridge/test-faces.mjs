import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import sharp from 'sharp';
import { facesInit, decodeImage, detectFaces, alignFace, embedFace, cosine, alignedJpeg } from './faces.js';
import { BlacklistMatcher } from './blacklist.js';

let passed = 0, failed = 0; const out = [];
const t = async (n, f) => { try { await f(); passed++; out.push(`  ok   ${n}`); } catch (e) { failed++; out.push(`  FAIL ${n}\n         ${e.message}`); } };
const yes = (c, m) => { if (!c) throw new Error(m || 'не выполнено'); };

const IMG = {
  zidane: ['/tmp/sz_zid.jpg', 'https://raw.githubusercontent.com/ultralytics/ultralytics/main/ultralytics/assets/zidane.jpg'],
  lena: ['/tmp/sz_lena.jpg', 'https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/lena.jpg'],
  messi: ['/tmp/sz_messi.jpg', 'https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/messi5.jpg'],
};
for (const [file, url] of Object.values(IMG)) if (!existsSync(file)) execSync(`curl -sL --max-time 20 -o ${file} ${url}`);
const buf = k => readFileSync(IMG[k][0]);

await facesInit('.');
async function faceEmb(b, pick = fs => fs[0]) {
  const img = await decodeImage(b);
  const fs = (await detectFaces(img)).sort((a, z) => (z.x2 - z.x1) - (a.x2 - a.x1));
  if (!fs.length) return null;
  const f = pick(fs);
  return { emb: await embedFace(alignFace(img, f.lm)), width: f.x2 - f.x1, aligned: alignFace(img, f.lm) };
}

console.log('\n=== Чёрный список: настоящие модели, настоящие лица ===\n');

await t('находит оба лица у Зидана с Анчелотти и одно у Лены', async () => {
  const z = await detectFaces(await decodeImage(buf('zidane')));
  const l = await detectFaces(await decodeImage(buf('lena')));
  yes(z.length === 2 && l.length === 1, `нашлось ${z.length} и ${l.length}`);
});
await t('пять точек лица внутри рамки лица', async () => {
  for (const f of await detectFaces(await decodeImage(buf('zidane')))) {
    yes(f.lm.every(([x, y]) => x >= f.x1 - 5 && x <= f.x2 + 5 && y >= f.y1 - 5 && y <= f.y2 + 5), 'точка вне лица');
  }
});

const lena = await faceEmb(buf('lena'));
const variants = {
  'темнее': await sharp(buf('lena')).modulate({ brightness: 0.7 }).jpeg().toBuffer(),
  'зеркально': await sharp(buf('lena')).flop().jpeg().toBuffer(),
  'сильное сжатие': await sharp(buf('lena')).jpeg({ quality: 30 }).toBuffer(),
};
for (const [name, b] of Object.entries(variants)) {
  await t(`тот же человек (${name}) — выше порога 0.45`, async () => {
    const s = cosine(lena.emb, (await faceEmb(b)).emb);
    yes(s >= 0.45, `сходство ${s.toFixed(2)}`);
  });
}
await t('разные люди — ниже порога 0.45', async () => {
  const people = [lena, await faceEmb(buf('messi')), await faceEmb(buf('zidane'), fs => fs[0]), await faceEmb(buf('zidane'), fs => fs[1])];
  for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
    const s = cosine(people[i].emb, people[j].emb);
    yes(s < 0.45, `пара ${i}-${j}: ${s.toFixed(2)}`);
  }
});

await t('полный путь: внесли по фото → появился темнее → совпадение', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e1', label: 'Тест', embedding: Array.from(lena.emb), thumb: (await alignedJpeg(lena.aligned)).toString('base64') }]);
  const seen = await faceEmb(variants['темнее']);
  const hit = m.match(seen.emb, seen.width, 1000);
  yes(hit && hit.entry.label === 'Тест', 'совпадения нет');
});
await t('посторонние люди при том же списке — тишина', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e1', label: 'Тест', embedding: Array.from(lena.emb) }]);
  for (const k of [0, 1]) {
    const p = await faceEmb(buf('zidane'), fs => fs[k]);
    yes(m.match(p.emb, p.width, 1000) === null, 'ложное совпадение');
  }
});
await t('мелкое лицо (у Месси 30 px) не сравнивается вовсе', async () => {
  const messi = await faceEmb(buf('messi'));
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e2', label: 'Месси', embedding: Array.from(messi.emb) }]);
  yes(messi.width < 60, `ширина ${messi.width}`);
  yes(m.match(messi.emb, messi.width, 1000) === null, 'мелкое лицо дало совпадение');
});
await t('одно совпадение — одна тревога за 10 минут', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e1', label: 'Тест', embedding: Array.from(lena.emb) }]);
  const n = [0, 1000, 60_000, 11 * 60_000].filter(at => m.match(lena.emb, 140, at)).length;
  yes(n === 2, `тревог ${n}`);
});
await t('лица посетителей нигде не остаются: в памяти только список и время тревог', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'e1', label: 'Тест', embedding: Array.from(lena.emb) }]);
  for (const k of [0, 1]) { const p = await faceEmb(buf('zidane'), fs => fs[k]); m.match(p.emb, p.width, 1000); }
  yes(m.entries.length === 1 && m.lastAlert.size === 0, 'в памяти что-то лишнее');
});
await t('битые записи списка отбрасываются', async () => {
  const m = new BlacklistMatcher();
  m.setEntries([{ id: 'x', embedding: [1, 2, 3] }, { id: 'y', embedding: null }, { id: 'z', embedding: Array.from(lena.emb) }]);
  yes(m.size === 1, `записей ${m.size}`);
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
process.exit(failed ? 1 : 0);
