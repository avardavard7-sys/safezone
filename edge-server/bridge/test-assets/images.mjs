// Тестовые кадры из двух снимков в общественном достоянии (см. LICENSES.txt).
import { readFileSync } from 'fs';
import sharp from 'sharp';

const file = (name) => readFileSync(new URL(`./${name}`, import.meta.url));

export const astronaut = () => file('astronaut.jpg');
export const twoPeople = () => file('two_people.jpg');

/** Три человека в одном кадре: астронавт и двое с официального фото. */
export async function crowd() {
  const h = 661;
  const a = await sharp(astronaut()).resize({ height: h }).toBuffer();
  const t = twoPeople();
  const tm = await sharp(t).metadata();
  return sharp({ create: { width: h + tm.width, height: h, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .composite([{ input: a, left: 0, top: 0 }, { input: t, left: h, top: 0 }])
    .jpeg({ quality: 90 }).toBuffer();
}

/** Лицо шириной около 30 пикселей: человек далеко от камеры. */
export async function smallFace() {
  const small = await sharp(astronaut()).resize(128).toBuffer();
  return sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 95, b: 100 } } })
    .composite([{ input: small, left: 256, top: 176 }])
    .jpeg({ quality: 92 }).toBuffer();
}
