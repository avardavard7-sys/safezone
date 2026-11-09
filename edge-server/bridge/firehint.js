// firehint.js — быстрая проверка «похоже на огонь» по цвету пикселей, без моделей.

import sharp from 'sharp';

export async function fireHint(jpegBuffer) {
  const { data } = await sharp(jpegBuffer)
    .resize(160, 160, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let firePix = 0;
  const total = 160 * 160;
  for (let i = 0; i < total; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    if (r > 200 && g > 90 && g < 200 && b < 110 && r - b > 110) firePix++;
  }
  return firePix / total;
}
