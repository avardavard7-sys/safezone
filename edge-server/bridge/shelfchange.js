// Прямое свидетельство: с полки исчез предмет, пока рядом была рука.
// Сравнивается вид полки до и после — по структуре блоков, а не по яркости,
// поэтому тени и смена света не считаются изменением.
import sharp from 'sharp';

export const W = 960, H = 540, B = 8;
export const WB = W / B, HB = Math.floor(H / B);
const N = WB * HB, BB = B * B;

const KP = { lSh: 5, rSh: 6, lWr: 9, rWr: 10, lHip: 11, rHip: 12 };
const BAG = new Set(['backpack', 'handbag', 'suitcase']);

export async function decodeGray(jpeg) {
  const { data } = await sharp(jpeg).resize(W, H, { fit: 'fill' }).grayscale().blur(1.1).raw().toBuffer({ resolveWithObject: true });
  return data;
}

export function blockStats(gray) {
  const mu = new Float32Array(N), sd = new Float32Array(N), z = new Float32Array(N * BB);
  for (let by = 0; by < HB; by++) {
    for (let bx = 0; bx < WB; bx++) {
      const i = by * WB + bx;
      let s = 0;
      for (let y = 0; y < B; y++) {
        const row = (by * B + y) * W + bx * B;
        for (let x = 0; x < B; x++) s += gray[row + x];
      }
      const m = s / BB;
      let v = 0, k = i * BB;
      for (let y = 0; y < B; y++) {
        const row = (by * B + y) * W + bx * B;
        for (let x = 0; x < B; x++) { const d = gray[row + x] - m; z[k++] = d; v += d * d; }
      }
      mu[i] = m; sd[i] = Math.sqrt(v / BB);
    }
  }
  return { mu, sd, z };
}

export function blockChanged(ref, cur, i, { tex = 7, ncc = 0.55, flat = 28 } = {}) {
  const sr = ref.sd[i], sc = cur.sd[i];
  if (sr > tex || sc > tex) {
    let dot = 0;
    const k = i * BB;
    for (let j = 0; j < BB; j++) dot += ref.z[k + j] * cur.z[k + j];
    const c = dot / BB / (sr * sc + 1e-3);
    return c < ncc || (Math.min(sr, sc) < tex * 0.5 && Math.abs(sr - sc) > tex);
  }
  return Math.abs(ref.mu[i] - cur.mu[i]) > flat;
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    const ax = a.x ?? a[0], ay = a.y ?? a[1], bx = b.x ?? b[0], by = b.y ?? b[1];
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

const boxOf = p => p.box || p;

export class ShelfChange {
  constructor({ regions = [], persist = 4, freeFrames = 6, minBlocks = 3, maxWrist = 0.10, followMs = 5000, mergeMs = 1500 } = {}) {
    Object.assign(this, { persist, freeFrames, minBlocks, maxWrist, followMs, mergeMs });
    this.ref = null;
    this.valid = new Uint8Array(N);
    this.clear = new Int32Array(N);
    this.cnt = new Int32Array(N);
    this.reported = new Uint8Array(N);
    this.free = 0;
    this.recent = [];
    this.pending = [];
    this.wrists = [];
    this.before = null;
    this.beforeAt = -Infinity;
    this.setRegions(regions);
  }

  setRegions(regions) {
    this.regions = (regions || []).filter(r => r.kind === 'shelf' && Array.isArray(r.points) && r.points.length >= 3);
    this.region = new Int16Array(N).fill(-1);
    for (let by = 0; by < HB; by++) for (let bx = 0; bx < WB; bx++) {
      const x = (bx + 0.5) / WB, y = (by + 0.5) / HB;
      const k = this.regions.findIndex(r => pointInPoly(x, y, r.points));
      this.region[by * WB + bx] = k;
    }
  }

  get following() { return this.pending.length > 0; }

  personBlocks(people, pad = 0.02) {
    const m = new Uint8Array(N);
    for (const p of people) {
      const b = boxOf(p);
      const x1 = Math.max(0, Math.floor((b.x1 - pad) * WB)), x2 = Math.min(WB - 1, Math.floor((b.x2 + pad) * WB));
      const y1 = Math.max(0, Math.floor((b.y1 - pad) * HB)), y2 = Math.min(HB - 1, Math.floor((b.y2 + pad) * HB));
      for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) m[y * WB + x] = 1;
    }
    return m;
  }

  // gray — кадр W×H в оттенках серого; people — люди с рамкой и kpts; bags — рамки сумок
  step(gray, people, t, { bags = [], jpeg = null } = {}) {
    const cur = blockStats(gray);
    const pm = this.personBlocks(people);
    let near = false;
    for (let i = 0; i < N; i++) if (pm[i] && this.region[i] >= 0) { near = true; break; }

    for (const p of people) {
      if (!p.kpts) continue;
      for (const wi of [KP.lWr, KP.rWr]) {
        const k = p.kpts[wi];
        if (k && k.c >= 0.3) this.wrists.push({ t, x: k.x, y: k.y, id: p.id ?? null });
      }
    }
    this.wrists = this.wrists.filter(w => t - w.t <= 4000);
    const alerts = this.follow(people, bags, t);

    if (!this.ref) {
      this.ref = cur;
      for (let i = 0; i < N; i++) this.valid[i] = pm[i] ? 0 : 1;
      return { picks: [], alerts };
    }
    for (let i = 0; i < N; i++) {
      this.clear[i] = pm[i] ? 0 : this.clear[i] + 1;
      if (!this.valid[i] && this.clear[i] >= this.freeFrames) { this.copyBlock(cur, i); this.valid[i] = 1; }
    }

    if (!near) {
      this.free++;
      if (this.free >= this.freeFrames) {
        for (let i = 0; i < N; i++) {
          this.ref.mu[i] += 0.2 * (cur.mu[i] - this.ref.mu[i]);
          this.ref.sd[i] += 0.2 * (cur.sd[i] - this.ref.sd[i]);
        }
        for (let i = 0; i < N * BB; i++) this.ref.z[i] += 0.2 * (cur.z[i] - this.ref.z[i]);
        this.cnt.fill(0); this.reported.fill(0);
        if (jpeg && t - this.beforeAt > 2000) { this.before = jpeg; this.beforeAt = t; }
      }
      return { picks: [], alerts };
    }
    this.free = 0;

    const stable = new Uint8Array(N);
    let any = false;
    for (let i = 0; i < N; i++) {
      if (pm[i]) continue;
      const ch = this.region[i] >= 0 && this.valid[i] && blockChanged(this.ref, cur, i);
      this.cnt[i] = ch ? this.cnt[i] + 1 : 0;
      if (this.cnt[i] >= this.persist && !this.reported[i]) { stable[i] = 1; any = true; }
    }
    const picks = [];
    if (any) {
      for (const blob of this.components(stable)) {
        if (blob.cells.length < this.minBlocks) continue;
        for (const i of blob.cells) this.markReported(i);
        const cx = blob.sx / blob.cells.length / WB, cy = blob.sy / blob.cells.length / HB;
        let best = null;
        for (const w of this.wrists) {
          const d = Math.hypot(w.x - cx, w.y - cy);
          if (!best || d < best.d) best = { d, id: w.id };
        }
        if (!best || best.d > this.maxWrist) continue;
        if (this.recent.some(e => t - e.at < this.mergeMs && Math.hypot(e.cx - cx, e.cy - cy) < 0.08)) continue;
        const regionIdx = this.region[blob.cells[0]];
        const ev = {
          at: t, cx, cy, blocks: blob.cells.length, wristDist: best.d, trackId: best.id,
          box: { x1: blob.x1 / WB, y1: blob.y1 / HB, x2: (blob.x2 + 1) / WB, y2: (blob.y2 + 1) / HB },
          shelf: this.regions[regionIdx] || { name: 'Полка' },
          before: this.before, where: null,
        };
        this.recent.push(ev); this.pending.push(ev); picks.push(ev);
      }
      this.recent = this.recent.filter(e => t - e.at < 60000);
    }
    return { picks, alerts };
  }

  async observe(jpeg, people, t, opts = {}) {
    if (!this.regions.length) return { picks: [], alerts: [] };
    return this.step(await decodeGray(jpeg), people, t, { ...opts, jpeg });
  }

  copyBlock(cur, i) {
    this.ref.mu[i] = cur.mu[i]; this.ref.sd[i] = cur.sd[i];
    this.ref.z.set(cur.z.subarray(i * BB, (i + 1) * BB), i * BB);
  }

  markReported(i) {
    const x = i % WB, y = (i - x) / WB;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < WB && ny >= 0 && ny < HB) this.reported[ny * WB + nx] = 1;
    }
  }

  components(mask) {
    const seen = new Uint8Array(N), out = [];
    for (let s = 0; s < N; s++) {
      if (!mask[s] || seen[s]) continue;
      const blob = { cells: [], sx: 0, sy: 0, x1: WB, y1: HB, x2: 0, y2: 0 };
      const stack = [s]; seen[s] = 1;
      while (stack.length) {
        const i = stack.pop(), x = i % WB, y = (i - x) / WB;
        blob.cells.push(i); blob.sx += x + 0.5; blob.sy += y + 0.5;
        blob.x1 = Math.min(blob.x1, x); blob.x2 = Math.max(blob.x2, x);
        blob.y1 = Math.min(blob.y1, y); blob.y2 = Math.max(blob.y2, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= WB || ny < 0 || ny >= HB) continue;
          const j = ny * WB + nx;
          if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      out.push(blob);
    }
    return out;
  }

  // после исчезновения предмета смотрим, куда ушла рука того же человека
  follow(people, bags, t) {
    const done = [], keep = [];
    for (const ev of this.pending) {
      const who = people.filter(p => ev.trackId == null || p.id == null || p.id === ev.trackId);
      for (const p of who) {
        const spot = handSpot(p, bags);
        if (spot === 'bag') { ev.where = 'bag'; break; }
        if (spot === 'body' && !ev.where) ev.where = 'body';
      }
      if (ev.where === 'bag' || t - ev.at >= this.followMs) {
        if (ev.where) done.push(ev);
        continue;
      }
      keep.push(ev);
    }
    this.pending = keep;
    return done;
  }
}

export function handSpot(p, bags = []) {
  const k = p.kpts;
  if (!k) return null;
  let body = false;
  for (const wi of [KP.lWr, KP.rWr]) {
    const w = k[wi];
    if (!w || w.c < 0.3) continue;
    for (const b0 of bags) {
      if (b0.cls && !BAG.has(b0.cls)) continue;
      const b = boxOf(b0);
      if (w.x >= b.x1 - 0.02 && w.x <= b.x2 + 0.02 && w.y >= b.y1 - 0.02 && w.y <= b.y2 + 0.02) return 'bag';
    }
    const ls = k[KP.lSh], rs = k[KP.rSh], lh = k[KP.lHip], rh = k[KP.rHip];
    if (!ls || !rs || Math.min(ls.c, rs.c) <= 0.3) continue;
    const sx = (ls.x + rs.x) / 2, sy = (ls.y + rs.y) / 2, width = Math.abs(ls.x - rs.x) + 0.03;
    const hy = lh && rh && Math.min(lh.c, rh.c) > 0.3 ? (lh.y + rh.y) / 2 : sy + 2.2 * width;
    if (Math.abs(w.x - sx) < width * 0.9 && w.y > sy + 0.15 * (hy - sy) && w.y < hy + 0.25 * (hy - sy)) body = true;
  }
  return body ? 'body' : null;
}

// снимок-доказательство: полка до, полка после с рамкой, кадр в момент тревоги
export async function changeEvidence(ev, afterJpeg, nowJpeg) {
  const pw = 640, ph = 360;
  const b = ev.box;
  const rect = `<svg width="${pw}" height="${ph}"><rect x="${Math.max(0, b.x1 * pw - 6)}" y="${Math.max(0, b.y1 * ph - 6)}" width="${(b.x2 - b.x1) * pw + 12}" height="${(b.y2 - b.y1) * ph + 12}" fill="none" stroke="#ff2a2a" stroke-width="3"/></svg>`;
  const label = (text, color) => Buffer.from(`<svg width="${pw}" height="${ph}"><rect x="0" y="0" width="${text.length * 11 + 16}" height="26" fill="${color}"/><text x="8" y="19" font-family="sans-serif" font-size="16" fill="#fff">${text}</text></svg>`);
  const panel = async (jpeg, text, color, withRect) => sharp(jpeg).resize(pw, ph, { fit: 'fill' })
    .composite([...(withRect ? [{ input: Buffer.from(rect) }] : []), { input: label(text, color) }]).jpeg({ quality: 82 }).toBuffer();
  const parts = [];
  if (ev.before) parts.push(await panel(ev.before, 'ДО', '#1f8f4a', true));
  parts.push(await panel(afterJpeg, 'ПОСЛЕ', '#c0392b', true));
  if (nowJpeg && nowJpeg !== afterJpeg) parts.push(await panel(nowJpeg, 'РУКА', '#34495e', false));
  return sharp({ create: { width: pw * parts.length, height: ph, channels: 3, background: '#000' } })
    .composite(parts.map((input, i) => ({ input, left: i * pw, top: 0 }))).jpeg({ quality: 82 }).toBuffer();
}

export const VERIFY_PROMPT = `Перед тобой склейка кадров одной камеры магазина. Слева «ДО» — полка до подхода человека, красная рамка отмечает место. Затем «ПОСЛЕ» — та же полка, в рамке что-то изменилось. Справа «РУКА» — человек в момент, когда его рука ушла к сумке или к телу.
Ответь строго JSON: {"item_taken": true|false, "concealed": true|false, "where": "сумка|карман|под одежду|в руке|корзина|не видно", "confidence": 0..1, "comment": "одно короткое предложение"}.
item_taken — в рамке действительно исчез или сдвинут предмет (не тень и не блик). concealed — предмет спрятан: его не видно в руке, корзине или тележке.`;

export function judgeVerdict(v) {
  if (!v || typeof v !== 'object') return { send: true, note: 'без облачной проверки' };
  const conf = Number(v.confidence) || 0;
  if (v.item_taken === false && conf >= 0.7) return { send: false, note: v.comment || 'облако: предмет на месте' };
  if (v.concealed === false && conf >= 0.7) return { send: false, note: v.comment || 'облако: предмет в руке или корзине' };
  return { send: true, note: v.comment ? `Облако: ${v.comment}` : 'облако подтвердило' };
}
