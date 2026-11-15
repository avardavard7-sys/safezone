/**
 * Сравнение лица со списком. Порог выше стандартного для SFace (0.363):
 * ошибочное совпадение здесь — это подозрение на невиновного человека.
 * Мелкие лица не сравниваем вовсе — на них отпечаток ненадёжен.
 */
import { cosine } from './faces.js';

export class BlacklistMatcher {
  constructor({ threshold = 0.45, minFacePx = 60, cooldownMs = 10 * 60 * 1000 } = {}) {
    this.threshold = threshold;
    this.minFacePx = minFacePx;
    this.cooldownMs = cooldownMs;
    this.entries = [];
    this.lastAlert = new Map();
  }

  setEntries(entries) {
    this.entries = (entries || [])
      .filter(e => Array.isArray(e.embedding) && e.embedding.length === 128)
      .map(e => ({ id: e.id, label: e.label, thumb: e.thumb || null, emb: Float32Array.from(e.embedding) }));
  }

  get size() { return this.entries.length; }

  /** Лучшее совпадение для лица или null. Отпечаток лица после вызова не хранится. */
  match(emb, faceWidthPx, nowMs) {
    if (!this.entries.length || faceWidthPx < this.minFacePx) return null;
    let best = null;
    for (const e of this.entries) {
      const score = cosine(emb, e.emb);
      if (!best || score > best.score) best = { entry: e, score };
    }
    if (!best || best.score < this.threshold) return null;
    const last = this.lastAlert.get(best.entry.id);
    if (last !== undefined && nowMs - last < this.cooldownMs) return null;
    this.lastAlert.set(best.entry.id, nowMs);
    return best;
  }
}
