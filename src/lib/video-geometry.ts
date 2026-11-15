export type Fit = 'cover' | 'contain';
export type Rect = { x: number; y: number; w: number; h: number };

/** Где внутри окна W×H лежит кадр vw×vh при заданном способе вписывания. */
export function frameRect(vw: number, vh: number, W: number, H: number, fit: Fit): Rect {
  if (!vw || !vh || !W || !H) return { x: 0, y: 0, w: W, h: H };
  const s = fit === 'cover' ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh);
  const w = vw * s, h = vh * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

export function toScreen(nx: number, ny: number, r: Rect) {
  return { x: r.x + nx * r.w, y: r.y + ny * r.h };
}

/** Клик в окне → доли кадра; null, если клик мимо кадра (по чёрным полям). */
export function toFrame(px: number, py: number, r: Rect) {
  const x = (px - r.x) / r.w, y = (py - r.y) / r.h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** Стрелка «внутрь»: от середины линии по нормали в сторону inside. */
export function insideNormal(l: { x1: number; y1: number; x2: number; y2: number; inside: 'left' | 'right' }) {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const len = Math.hypot(dx, dy) || 1;
  const s = l.inside === 'left' ? 1 : -1;
  return { mx: (l.x1 + l.x2) / 2, my: (l.y1 + l.y2) / 2, nx: (-dy / len) * s, ny: (dx / len) * s };
}
