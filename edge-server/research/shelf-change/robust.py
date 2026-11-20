import cv2, json, sys, numpy as np
sys.path.insert(0, 'code'); from shelfchange import ShelfChange
AB = [[[0.385,0.47],[0.65,0.47],[0.65,0.80],[0.385,0.80]]]
def run(name, v, lo, hi, fx):
    frames = json.load(open(f'data/{v}.json')); first = cv2.imread(f'data/f{v}/{frames[0]["f"]}'); sc = ShelfChange(first.shape[:2], AB); n = 0
    for i, fr in enumerate(frames[:hi]):
        img = cv2.imread(f'data/f{v}/{fr["f"]}')
        if i >= lo: img = fx(img, i - lo)
        boxes = fr['persons'] + [dict(d, kpts=[dict(x=0,y=0,c=0)]*17) for d in fr['dets'] if d['cls']=='person']
        n += len(sc.step(img, boxes, i * 1000 / 6))
    print(f'{name}: ложных событий {n}')
def shadow(img, k):
    h, w = img.shape[:2]; m = np.ones((h, w), np.float32); cx = int(w * (0.40 + 0.01 * k)); cv2.ellipse(m, (cx, int(h * 0.62)), (int(w * 0.10), int(h * 0.14)), 0, 0, 360, 0.65, -1)
    m = cv2.GaussianBlur(m, (0, 0), 25); return np.clip(img * m[..., None], 0, 255).astype(np.uint8)
dim = lambda img, k: np.clip(img.astype(np.float32) * 0.75, 0, 255).astype(np.uint8)
bright = lambda img, k: np.clip(img.astype(np.float32) * 1.25 + 8, 0, 255).astype(np.uint8)
noise = lambda img, k: np.clip(img.astype(np.float32) + np.random.default_rng(k).normal(0, 6, img.shape), 0, 255).astype(np.uint8)
ident = lambda img, k: img
# до первой кражи человек уже стоит у стола: A — кадры 18..32, B — 22..38
for v, lo, hi in (('A', 18, 33), ('B', 22, 39)):
    run(f'{v} без изменений, человек у стола, ничего не берёт', v, lo, hi, ident)
    run(f'{v} движущаяся тень на полке', v, lo, hi, shadow)
    run(f'{v} свет стал темнее на 25%', v, lo, hi, dim)
    run(f'{v} свет стал ярче на 25%', v, lo, hi, bright)
    run(f'{v} шум камеры', v, lo, hi, noise)
