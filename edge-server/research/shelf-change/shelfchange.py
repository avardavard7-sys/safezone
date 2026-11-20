import cv2, json, sys, os, numpy as np
BLOCK = 8

def poly_mask(shape, polys):
    h, w = shape; m = np.zeros((h, w), np.uint8)
    for p in polys: cv2.fillPoly(m, [np.int32([[x * w, y * h] for x, y in p])], 255)
    return m

def block_stats(gray):
    h, w = gray.shape; hb, wb = h // BLOCK, w // BLOCK
    g = gray[:hb * BLOCK, :wb * BLOCK].astype(np.float32).reshape(hb, BLOCK, wb, BLOCK).transpose(0, 2, 1, 3).reshape(hb, wb, -1)
    mu = g.mean(-1); z = g - mu[..., None]; sd = z.std(-1)
    return z, mu, sd

def changed_blocks(ref, cur, tex=7.0, ncc_thr=0.55, flat_thr=28.0):
    zr, mr, sr = ref; zc, mc, sc = cur
    ncc = (zr * zc).mean(-1) / (sr * sc + 1e-3)
    textured = (sr > tex) | (sc > tex)
    struct = textured & ((ncc < ncc_thr) | (np.minimum(sr, sc) < tex * 0.5) & (np.abs(sr - sc) > tex))
    flat = (~textured) & (np.abs(mr - mc) > flat_thr)
    return struct | flat

class ShelfChange:
    """Прямое свидетельство: с полки что-то исчезло или сдвинулось, пока рядом был человек."""
    def __init__(self, shape, polys, persist=4, free_frames=6, min_blocks=3, max_wrist=0.10):
        self.max_wrist = max_wrist
        self.h, self.w = shape; self.mask = poly_mask(shape, polys)
        hb, wb = self.h // BLOCK, self.w // BLOCK
        self.bmask = cv2.resize(self.mask, (wb, hb), interpolation=cv2.INTER_NEAREST) > 0
        self.ref = None; self.cnt = np.zeros((hb, wb), np.int32); self.reported = np.zeros((hb, wb), bool)
        self.persist, self.free_frames, self.min_blocks = persist, free_frames, min_blocks
        self.free = 0; self.events = []; self.wrist_hist = []; self.valid = None; self.clear = None

    def person_blocks(self, boxes, pad=0.02):
        hb, wb = self.bmask.shape; m = np.zeros((hb, wb), bool)
        for b in boxes:
            x1 = int(max(0, (b['x1'] - pad)) * wb); x2 = int(min(1, (b['x2'] + pad)) * wb) + 1
            y1 = int(max(0, (b['y1'] - pad)) * hb); y2 = int(min(1, (b['y2'] + pad)) * hb) + 1
            m[y1:y2, x1:x2] = True
        return m

    def step(self, frame_bgr, persons, t):
        gray = cv2.GaussianBlur(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        cur = block_stats(gray); pm = self.person_blocks(persons)
        near = (pm & self.bmask).any()
        for p in persons:
            for i in (9, 10):
                k = p['kpts'][i]
                if k['c'] >= 0.3: self.wrist_hist.append((t, k['x'], k['y'], id(p)))
        self.wrist_hist = [w for w in self.wrist_hist if t - w[0] <= 4000]
        if self.ref is None:
            self.ref = [a.copy() for a in cur]; self.valid = ~pm; self.clear = np.zeros(pm.shape, np.int32); return []
        # блок, закрытый человеком с самого начала, получает эталон, когда откроется и постоит открытым
        self.clear = np.where(pm, 0, self.clear + 1)
        late = (~self.valid) & (self.clear >= self.free_frames)
        if late.any():
            for r, c in zip(self.ref, cur): r[late] = c[late]
            self.valid |= late
        if not near:
            self.free += 1
            if self.free >= self.free_frames:
                # полка свободна: эталон подтягивается к текущему виду (свет меняется медленно)
                for r, c in zip(self.ref, cur): r += 0.2 * (c - r)
                self.cnt[:] = 0; self.reported[:] = False
            return []
        self.free = 0
        ch = changed_blocks(self.ref, cur) & self.bmask & ~pm & self.valid
        self.cnt = np.where(ch, self.cnt + 1, np.where(pm, self.cnt, 0))
        stable = (self.cnt >= self.persist) & ~self.reported
        out = []
        if stable.any():
            n, lab, stats, cent = cv2.connectedComponentsWithStats(stable.astype(np.uint8), connectivity=8)
            for i in range(1, n):
                if stats[i, cv2.CC_STAT_AREA] < self.min_blocks: continue
                hb, wb = self.bmask.shape
                x, y, bw, bh = stats[i, :4]; cx, cy = cent[i][0] / wb, cent[i][1] / hb
                self.reported |= cv2.dilate((lab == i).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
                d = [(np.hypot(wx - cx, wy - cy), wt) for wt, wx, wy, _ in self.wrist_hist]
                dmin = min(d)[0] if d else None
                if dmin is None or dmin > self.max_wrist: continue
                if any(t - e['t'] < 1500 and np.hypot(e['cx'] - cx, e['cy'] - cy) < 0.08 for e in self.events): continue
                ev = dict(t=t, cx=cx, cy=cy, box=[x / wb, y / hb, (x + bw) / wb, (y + bh) / hb], blocks=int(stats[i, cv2.CC_STAT_AREA]), wrist_dist=dmin)
                self.events.append(ev); out.append(ev)
        return out

def conceal_after(frames, i0, ev, fps, win_s=5.0):
    """Куда ушла рука после изменения выкладки: сумка / карман / к торсу / неизвестно."""
    best = None
    for fr in frames[i0:i0 + int(win_s * fps)]:
        bags = [d for d in fr['dets'] if d['cls'] in ('backpack', 'handbag', 'suitcase')]
        for p in fr['persons']:
            k = p['kpts']
            for wi in (9, 10):
                w = k[wi]
                if w['c'] < 0.3: continue
                for b in bags:
                    if b['x1'] - 0.02 <= w['x'] <= b['x2'] + 0.02 and b['y1'] - 0.02 <= w['y'] <= b['y2'] + 0.02: return 'рука в сумке/рюкзаке'
                sh = [k[5], k[6]]; hp = [k[11], k[12]]
                if min(s['c'] for s in sh) > 0.3:
                    sx = (sh[0]['x'] + sh[1]['x']) / 2; sy = (sh[0]['y'] + sh[1]['y']) / 2
                    width = abs(sh[0]['x'] - sh[1]['x']) + 0.03
                    hy = (hp[0]['y'] + hp[1]['y']) / 2 if min(h['c'] for h in hp) > 0.3 else sy + 2.2 * width
                    if abs(w['x'] - sx) < width * 0.9 and sy + 0.15 * (hy - sy) < w['y'] < hy + 0.25 * (hy - sy): best = best or 'рука у тела (торс/пояс)'
    return best or 'не видно, куда делся предмет'

if __name__ == '__main__':
    name, fdir, js, polys, outdir = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4]), sys.argv[5]
    fps = 6.0; frames = json.load(open(js)); os.makedirs(outdir, exist_ok=True)
    first = cv2.imread(os.path.join(fdir, frames[0]['f'])); sc = ShelfChange(first.shape[:2], polys)
    evs = []
    for i, fr in enumerate(frames):
        img = cv2.imread(os.path.join(fdir, fr['f'])); t = i * 1000 / fps
        boxes = fr['persons'] + [d for d in fr['dets'] if d['cls'] == 'person']
        for b in boxes: b.setdefault('kpts', [dict(x=0, y=0, c=0)] * 17)
        for ev in sc.step(img, boxes, t):
            ev['where'] = conceal_after(frames, i, ev, fps); evs.append(ev)
            h, w = img.shape[:2]; x1, y1, x2, y2 = [int(v * s) for v, s in zip(ev['box'], (w, h, w, h))]
            vis = img.copy(); cv2.rectangle(vis, (x1 - 6, y1 - 6), (x2 + 6, y2 + 6), (0, 0, 255), 2)
            cv2.imwrite(f'{outdir}/{name}_ev{len(evs)}_after.jpg', vis)
            r = first.copy(); cv2.rectangle(r, (x1 - 6, y1 - 6), (x2 + 6, y2 + 6), (0, 255, 0), 2); cv2.imwrite(f'{outdir}/{name}_ev{len(evs)}_before.jpg', r)
    print(f'{name}: событий «с полки что-то исчезло/сдвинулось»: {len(evs)}')
    for e in evs: print(f"   {e['t']/1000:.1f}с  место ({e['cx']:.2f},{e['cy']:.2f})  блоков {e['blocks']}  до ближайшей кисти {e['wrist_dist'] if e['wrist_dist'] is None else round(e['wrist_dist'],3)}  → {e['where']}")
