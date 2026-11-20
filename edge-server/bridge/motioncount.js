// Подсчёт по движению: кто пересёк линию, даже если детектор людей его не узнал
// (камера строго сверху, капюшон, зонт). Работает в паре с обычным подсчётом:
// проход, который уже посчитал детектор, второй раз не считается.
import { decodeGray, W, WB, HB, B } from './shelfchange.js';
import { LineCounter, sideOf } from './counter.js';

const N = WB * HB, BB = B * B, PX = W * HB * B;

function alongLine(line, p) {
  const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
  return ((p.x - line.x1) * dx + (p.y - line.y1) * dy) / Math.hypot(dx, dy);
}

function nearPerson(tr, dets) {
  for (const d of dets) {
    const b = d.box || d, mx = 0.25 * (b.x2 - b.x1), my = 0.25 * (b.y2 - b.y1);
    if (tr.cx >= b.x1 - mx && tr.cx <= b.x2 + mx && tr.cy >= b.y1 - my && tr.cy <= b.y2 + my) return true;
  }
  return false;
}

export class MotionCounter {
  constructor({ lines = [], minBlocks = 20, maxStep = 0.16, absorbFrames = 30, maxFg = 0.4, ttlMs = 1200, diff = 16, minTravel = 0.1 } = {}) {
    Object.assign(this, { minBlocks, maxStep, absorbFrames, maxFg, ttlMs, diff, minTravel });
    this.bg = null;
    this.age = new Int32Array(N);
    this.tracks = [];
    this.nextId = 1;
    this.personBlocks = [];
    this.settle = 0;
    this.counter = new LineCounter({ lines, minHits: 3 });
  }

  setLines(lines) { this.counter.setLines(lines); }

  // размер человека на этой камере берём у детектора, когда он кого-то видит
  learnSize(dets) {
    for (const d of dets) {
      const b = d.box || d;
      if ((d.conf ?? 1) < 0.5) continue;
      this.personBlocks.push((b.x2 - b.x1) * WB * (b.y2 - b.y1) * HB);
    }
    if (this.personBlocks.length > 200) this.personBlocks.splice(0, this.personBlocks.length - 200);
  }

  get minSize() {
    if (this.personBlocks.length < 10) return this.minBlocks;
    const s = [...this.personBlocks].sort((a, b) => a - b);
    return Math.max(6, Math.min(this.minBlocks * 4, 0.3 * s[s.length >> 1]));
  }

  step(gray, t, dets = []) {
    if (!this.bg) { this.bg = Float32Array.from(gray.subarray(0, PX)); return []; }
    const bg = this.bg;
    // общая смена яркости (автоэкспозиция, включили свет) компенсируется, чтобы не принять её за движение
    let sg = 0, sb = 0;
    for (let i = 0; i < PX; i += 7) { sg += gray[i]; sb += bg[i]; }
    const gain = sb > 0 ? sg / sb : 1;
    if (this.settle > 0) { this.settle--; this.bg = Float32Array.from(gray.subarray(0, PX)); return []; }
    const mad = new Float32Array(N);
    for (let by = 0; by < HB; by++) for (let bx = 0; bx < WB; bx++) {
      let sum = 0;
      for (let y = 0; y < B; y++) {
        const row = (by * B + y) * W + bx * B;
        for (let x = 0; x < B; x++) sum += Math.abs(gray[row + x] - bg[row + x] * gain);
      }
      mad[by * WB + bx] = sum / BB;
    }
    // порог подстраивается под шум камеры: обычный блок фона не должен считаться движением
    const sorted = Float32Array.from(mad).sort();
    const thr = Math.max(this.diff, 3 * sorted[N >> 1]);
    const fg = new Uint8Array(N);
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (mad[i] > thr) { fg[i] = 1; count++; this.age[i]++; } else this.age[i] = 0;
    }
    // сдвиг камеры или резкая смена всей картинки — пропускаем кадр, фон учим заново
    if (count > this.maxFg * N) { this.bg = Float32Array.from(gray.subarray(0, PX)); this.age.fill(0); this.tracks = []; this.settle = 5; return []; }
    for (let by = 0; by < HB; by++) for (let bx = 0; bx < WB; bx++) {
      const i = by * WB + bx;
      // то, что давно стоит на месте, становится фоном
      const a = fg[i] ? (this.age[i] >= this.absorbFrames ? 1 : 0) : 0.1;
      if (!a) continue;
      for (let y = 0; y < B; y++) {
        const row = (by * B + y) * W + bx * B;
        for (let x = 0; x < B; x++) bg[row + x] += a * (gray[row + x] - bg[row + x]);
      }
      if (a === 1) { this.age[i] = 0; fg[i] = 0; }
    }

    const blobs = this.#blobs(fg).filter(b => b.n >= this.minSize);
    const free = new Set(blobs);
    for (const tr of this.tracks) {
      let best = null, bd = this.maxStep;
      for (const b of free) {
        const d = Math.hypot(b.cx - tr.cx, b.cy - tr.cy);
        if (d < bd && b.n < tr.n * 3 && tr.n < b.n * 3) { bd = d; best = b; }
      }
      if (!best) continue;
      free.delete(best);
      tr.path += bd;
      tr.maxStep = Math.max(tr.maxStep, bd);
      if (bd > 0.008) tr.moves++;
      Object.assign(tr, { cx: best.cx, cy: best.cy, n: best.n, lastSeen: t });
      tr.hits++;
      if (nearPerson(tr, dets)) tr.detHits++;
    }
    for (const b of free) this.tracks.push({ id: this.nextId++, cx: b.cx, cy: b.cy, bx: b.cx, by: b.cy, n: b.n, lastSeen: t, wait: [], hits: 1, detHits: 0, path: 0, maxStep: 0, moves: 0 });
    this.tracks = this.tracks.filter(tr => t - tr.lastSeen <= this.ttlMs);

    const pseudo = this.tracks.map(tr => ({ id: tr.id, group: 'person', lastSeen: tr.lastSeen, box: { x1: tr.cx, x2: tr.cx, y1: tr.cy, y2: tr.cy } }));
    for (const e of this.counter.observe(pseudo, t)) {
      const tr = this.tracks.find(x => x.id === e.trackId);
      const line = this.counter.lines.find(l => l.id === e.lineId);
      tr.wait.push({ ...e, source: 'motion', pos: alongLine(line, { x: tr.cx, y: tr.cy }) });
    }
    // считаем только то, что действительно прошло путь, а не дрожит на месте
    const out = [];
    for (const tr of this.tracks) {
      if (!tr.wait.length) continue;
      const net = Math.hypot(tr.cx - tr.bx, tr.cy - tr.by);
      if (tr.hits < 4 || net < this.minTravel) continue;
      // человек идёт ровно; пятно от тени или блика скачет на месте
      if (net < 0.6 * tr.path) { tr.wait = []; continue; }
      // один большой скачок — это не ходьба, а перескок на другое пятно
      if (tr.moves < 3 || tr.maxStep > 0.6 * tr.path) continue;
      // там, где детектор людей видит, считает он: движение нужно только для тех, кого он не узнал
      if (tr.detHits <= 0.2 * tr.hits) out.push(...tr.wait);
      tr.wait = [];
    }
    return out;
  }

  async observe(jpeg, t, dets = []) {
    if (!this.counter.lines.length) return [];
    return this.step(await decodeGray(jpeg), t, dets);
  }

  #blobs(mask) {
    const seen = new Uint8Array(N), out = [];
    for (let s = 0; s < N; s++) {
      if (!mask[s] || seen[s]) continue;
      let n = 0, sx = 0, sy = 0;
      const stack = [s]; seen[s] = 1;
      while (stack.length) {
        const i = stack.pop(), x = i % WB, y = (i - x) / WB;
        n++; sx += x + 0.5; sy += y + 0.5;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= WB || ny < 0 || ny >= HB) continue;
          const j = ny * WB + nx;
          if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      out.push({ n, cx: sx / n / WB, cy: sy / n / HB });
    }
    return out;
  }
}

// Склейка двух счётчиков: проход по движению ждёт windowMs и отменяется,
// если тот же проход (та же линия, то же направление, то же место) посчитал детектор.
export class CountFusion {
  constructor({ lines = [], windowMs = 2500, nearby = 0.15 } = {}) {
    Object.assign(this, { windowMs, nearby });
    this.lines = lines;
    this.held = [];
    this.seen = [];
  }

  setLines(lines) { this.lines = lines; }

  // тот же человек в том же месте: направление не сравниваем — пятно движения у линии может качнуться назад
  #same(a, b) {
    return a.lineId === b.lineId && Math.abs(a.at - b.at) <= this.windowMs && Math.abs(a.pos - b.pos) <= this.nearby;
  }

  // detEvents — события LineCounter по трекам детектора; tracks — те же треки (нужно место прохода)
  push(detEvents, tracks, motionEvents, t) {
    const out = [];
    for (const e of detEvents) {
      const line = this.lines.find(l => l.id === e.lineId);
      const tr = tracks.find(x => x.id === e.trackId);
      const b = tr?.box;
      const d = { ...e, pos: line && b ? alongLine(line, { x: (b.x1 + b.x2) / 2, y: b.y2 }) : 0 };
      this.held = this.held.filter(m => !this.#same(m, d));
      this.seen.push(d);
      out.push(e);
    }
    for (const m of motionEvents) {
      if (this.seen.some(x => this.#same(x, m))) continue;
      this.held.push(m);
    }
    const keep = [];
    for (const m of this.held) (t - m.at >= this.windowMs ? out : keep).push(m);
    this.held = keep;
    this.seen = this.seen.filter(d => t - d.at <= this.windowMs * 2);
    return out;
  }
}

export { sideOf };
