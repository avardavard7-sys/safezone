// camguard.js — контроль камеры: сдвинули, закрыли или перевесили.
// Зоны и линии привязаны к виду камеры: если вид изменился, они молча становятся неверными.
// Сравниваются контуры сцены, а не сама картинка — свет и люди в кадре не мешают.

import sharp from 'sharp';
import { readFileSync, writeFileSync, renameSync } from 'fs';

const W = 64, H = 36;

/** Контурный «рисунок» сцены: карта границ на уменьшенном кадре. */
export async function signature(jpeg) {
  const { data } = await sharp(jpeg).resize(W, H, { fit: 'fill' }).grayscale().blur(1).raw().toBuffer({ resolveWithObject: true });
  const edges = new Float32Array(W * H);
  let energy = 0, brightness = 0;
  for (let i = 0; i < W * H; i++) brightness += data[i];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = (dx, dy) => data[(y + dy) * W + (x + dx)];
      const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
      const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
      const m = Math.hypot(gx, gy);
      edges[y * W + x] = m;
      energy += m;
    }
  }
  return { edges, energy: energy / (W * H), brightness: brightness / (W * H) };
}

/** Сходство двух рисунков при сдвиге второго на (dx, dy) клеток. От -1 до 1. */
function correlation(a, b, dx, dy) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = 2; y < H - 2; y++) {
    const yy = y + dy;
    if (yy < 2 || yy >= H - 2) continue;
    for (let x = 2; x < W - 2; x++) {
      const xx = x + dx;
      if (xx < 2 || xx >= W - 2) continue;
      const va = a[y * W + x], vb = b[yy * W + xx];
      n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
  }
  if (n < 200) return 0;
  const cov = sab - (sa * sb) / n;
  const den = Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n));
  return den > 1e-6 ? cov / den : 0;
}

export function compare(ref, cur, maxShift = 12) {
  const same = correlation(ref.edges, cur.edges, 0, 0);
  let best = { score: same, dx: 0, dy: 0 };
  for (let dy = -Math.min(6, maxShift); dy <= Math.min(6, maxShift); dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      if (!dx && !dy) continue;
      const s = correlation(ref.edges, cur.edges, dx, dy);
      if (s > best.score) best = { score: s, dx, dy };
    }
  }
  return { same, best };
}

/** Что с камерой прямо на этом кадре. */
export function verdict(ref, cur) {
  if (cur.energy < Math.max(1.5, ref.energy * 0.15)) return { state: 'blocked', score: 0 };
  const c = compare(ref, cur);
  if (c.same >= 0.55) return { state: 'ok', score: c.same };
  const moved = Math.abs(c.best.dx) + Math.abs(c.best.dy) >= 2;
  if (moved && c.best.score >= 0.55 && c.best.score - c.same >= 0.15) {
    return { state: 'shifted', score: c.same, dx: Math.round((c.best.dx / W) * 100), dy: Math.round((c.best.dy / H) * 100) };
  }
  if (c.same < 0.3) return { state: 'changed', score: c.same };
  return { state: 'ok', score: c.same };
}

const TEXT = {
  shifted: (v) => `Камеру сдвинули: вид смещён примерно на ${Math.abs(v.dx)}% по горизонтали и ${Math.abs(v.dy)}% по вертикали. Зоны и линии нужно проверить`,
  changed: () => 'Вид камеры изменился: её перевесили или перенаправили. Зоны и линии нужно нарисовать заново',
  blocked: () => 'Камера не видит сцену: объектив закрыт или полная темнота',
};

export class CameraGuard {
  /**
   * @param confirm   сколько проверок подряд должно показать проблему
   * @param minGapMs  минимум между проверками, чтобы «подряд» означало время, а не кадры
   * @param repeatMs  не чаще одного сообщения по камере за этот срок
   */
  constructor({ confirm = 3, minGapMs = 30_000, repeatMs = 6 * 3600_000, acceptAfterMs = 24 * 3600_000, file = null, onAccept = () => {} } = {}) {
    this.confirm = confirm; this.minGapMs = minGapMs; this.repeatMs = repeatMs; this.file = file;
    this.acceptAfterMs = acceptAfterMs; this.onAccept = onAccept;
    this.refs = new Map();
    this.state = new Map();
    if (file) this.load();
  }

  hasReference(camId) { return this.refs.has(String(camId)); }

  setReference(camId, sig) {
    this.refs.set(String(camId), { edges: sig.edges, energy: sig.energy, brightness: sig.brightness });
    this.state.delete(String(camId));
    this.save();
  }

  resetReference(camId) { this.refs.delete(String(camId)); this.state.delete(String(camId)); this.save(); }

  /** Проверка кадра. Возвращает сообщение о проблеме или null. Первый кадр камеры становится образцом. */
  check(camId, sig, now = Date.now()) {
    const id = String(camId);
    const ref = this.refs.get(id);
    if (!ref) {
      if (sig.energy >= 1.5) this.setReference(id, sig);
      return null;
    }
    const st = this.state.get(id) || { bad: 0, kind: null, lastCheck: 0, lastAlert: 0, since: 0 };
    if (now - st.lastCheck < this.minGapMs) return null;
    st.lastCheck = now;
    const v = verdict(ref, sig);
    if (v.state === 'ok') { st.bad = 0; st.kind = null; st.since = 0; this.state.set(id, st); return null; }
    if (st.kind !== v.state) st.since = now;
    st.bad = st.kind === v.state ? st.bad + 1 : 1;
    st.kind = v.state;
    this.state.set(id, st);
    if (st.bad < this.confirm) return null;
    // камеру переставили намеренно и сутки не возвращали: принимаем новый вид за образец
    if (v.state !== 'blocked' && st.lastAlert && now - st.since >= this.acceptAfterMs) {
      this.setReference(id, sig);
      this.onAccept(id);
      return null;
    }
    if (st.lastAlert && now - st.lastAlert < this.repeatMs) return null;
    st.lastAlert = now;
    return { type: v.state === 'blocked' ? 'camera_blocked' : 'camera_moved', state: v.state, description: TEXT[v.state](v), score: v.score };
  }

  save() {
    if (!this.file) return;
    try {
      const obj = {};
      for (const [id, r] of this.refs) obj[id] = { e: Buffer.from(new Uint16Array(r.edges.map(x => Math.min(65535, Math.round(x * 16)))).buffer).toString('base64'), energy: r.energy, brightness: r.brightness };
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, this.file);
    } catch {}
  }

  load() {
    try {
      const obj = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [id, r] of Object.entries(obj)) {
        const raw = Buffer.from(r.e, 'base64');
        const u16 = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);
        if (u16.length !== W * H) continue;
        this.refs.set(id, { edges: Float32Array.from(u16, x => x / 16), energy: r.energy, brightness: r.brightness });
      }
    } catch {}
  }
}
