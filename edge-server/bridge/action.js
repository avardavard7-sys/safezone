// action.js v7 — анализ действий по скелетам.
//
// Два режима:
//  1) analyzeActions()  — одиночный кадр (совместимость со старым пайплайном,
//     работает когда burst выключен/упал). Статические признаки.
//  2) analyzeBurstPoses() — ГЛАВНЫЙ режим: серия кадров 2-3 сек с реальными
//     dt (~0.25с) → настоящая динамика: скорость запястий, падение как переход,
//     устойчивый жест курения, сближение+удары для драки.
//
// Все скорости нормированы на РОСТ человека (ед. роста/сек) — инвариантны к
// удалению от камеры. Ориентиры: ходьба ~0.3-0.6 h/s взмах руки, удар 1.2-2.0 h/s.

import { getTracker } from './tracker.js';

const K = { nose: 0, lwrist: 9, rwrist: 10, lhip: 11, rhip: 12, lshoulder: 5, rshoulder: 6, lankle: 15, rankle: 16 };

function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
// расстояние в "единицах высоты кадра": x-компоненту приводим через aspect (W/H)
function distA(a, b, aspect) { return Math.hypot((a.x - b.x) * aspect, a.y - b.y); }
function center(p) { return { x: (p.x1 + p.x2) / 2, y: (p.y1 + p.y2) / 2 }; }

// ── СТАТИЧЕСКИЕ ПРИЗНАКИ ОДНОГО КАДРА ────────────────────────────────────────
function staticHints(p, aspect) {
  const hints = [];
  const k = p.kpts;
  const boxW = (p.x2 - p.x1) * aspect;   // реальные пропорции, не нормализованные
  const boxH = (p.y2 - p.y1);

  const nose = k[K.nose];
  const hipsOk = k[K.lhip].c > 0.3 && k[K.rhip].c > 0.3;
  const hips = mid(k[K.lhip], k[K.rhip]);
  const lying = boxW > boxH * 1.25;
  const headBelowHips = nose.c > 0.3 && hipsOk && nose.y > hips.y + boxH * 0.05;
  if ((lying && hipsOk) || headBelowHips) {
    hints.push({ type: 'fall', detail: lying ? 'тело в горизонтальном положении' : 'голова ниже уровня бёдер' });
  }

  if (nose.c > 0.3) {
    const headSize = Math.max(0.02, distA(k[K.lshoulder], k[K.rshoulder], aspect) * 0.7);
    for (const wi of [K.lwrist, K.rwrist]) {
      const w = k[wi];
      if (w.c > 0.3 && distA(w, nose, aspect) < headSize * 0.6) {
        hints.push({ type: 'hand_to_mouth', detail: 'рука удерживается у рта/лица (возможно курение)' });
        break;
      }
    }
  }
  return hints;
}

// ── ОДИНОЧНЫЙ КАДР (fallback-режим, совместим со старым index.js) ───────────
const hist = {};
export function analyzeActions(camId, persons, nowMs, aspect = 16 / 9) {
  const prev = hist[camId];
  hist[camId] = { persons, ts: nowMs };
  const hints = [];
  let maxWristSpeed = 0;

  for (const p of persons) {
    hints.push(...staticHints(p, aspect));

    if (prev && nowMs - prev.ts < 6000) {
      const c = center(p);
      let pm = null, bestD = 0.18;
      for (const pp of prev.persons) {
        const d = distA(c, center(pp), aspect);
        if (d < bestD) { bestD = d; pm = pp; }
      }
      if (pm) {
        const dt = (nowMs - prev.ts) / 1000;
        const h = Math.max(0.05, p.y2 - p.y1);
        for (const wi of [K.lwrist, K.rwrist]) {
          const a = p.kpts[wi], b = pm.kpts[wi];
          if (a.c > 0.3 && b.c > 0.3) {
            const v = distA(a, b, aspect) / dt / h; // ед. роста / сек
            if (v > maxWristSpeed) maxWristSpeed = v;
          }
        }
      }
    }
  }

  if (persons.length >= 2 && maxWristSpeed > 0.9) {
    for (let i = 0; i < persons.length; i++) {
      for (let j = i + 1; j < persons.length; j++) {
        const a = persons[i], b = persons[j];
        const gap = distA(center(a), center(b), aspect);
        const size = Math.max(a.y2 - a.y1, b.y2 - b.y1);
        if (gap < size * 0.8) {
          hints.push({ type: 'fight_signal', detail: 'двое вплотную + резкое движение рук' });
        }
      }
    }
  }

  const calm = persons.length > 0 && maxWristSpeed < 0.2 && hints.length === 0;
  const uniq = [];
  for (const h of hints) if (!uniq.some(u => u.type === h.type)) uniq.push(h);
  return { hints: uniq, calm, wristSpeed: maxWristSpeed };
}

// ── СЕРИЯ КАДРОВ (burst) — настоящая динамика ────────────────────────────────
/**
 * @param {string} camId
 * @param {Array<Array>} framesPersons  [i] = массив персон кадра i (норм. координаты + kpts)
 * @param {Array<number>} timestamps    мс каждого кадра
 * @param {number} aspect               W/H исходного кадра
 * @returns {{hints, calm, wristSpeed, bestFrameIdx, tracks}}
 */
export function analyzeBurstPoses(camId, framesPersons, timestamps, aspect = 16 / 9) {
  const tr = getTracker(camId);
  const N = framesPersons.length;
  const seq = {}; // trackId → [{frame, kpts, box, t}]

  for (let i = 0; i < N; i++) {
    const dets = framesPersons[i].map(p => ({ cls: 'person', conf: p.conf, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, kpts: p.kpts }));
    tr.update(dets, timestamps[i]);
    for (const t of tr.persons(timestamps[i], 500)) {
      if (!seq[t.id]) seq[t.id] = [];
      seq[t.id].push({ frame: i, kpts: t.kpts, box: { ...t.box }, t: timestamps[i] });
    }
  }

  const hints = [];
  const frameActivity = new Array(N).fill(0);
  let maxWristSpeed = 0;
  const trackStats = {};

  for (const [id, samples] of Object.entries(seq)) {
    if (samples.length < 2) {
      // трек виден один кадр — только статика
      const s = samples[0];
      if (s?.kpts) for (const h of staticHints({ ...s.box, kpts: s.kpts, conf: 1 }, aspect)) {
        hints.push({ ...h, trackId: +id });
        frameActivity[s.frame] += 2;
      }
      continue;
    }

    let wristMax = 0, wristMaxFrame = 0;
    let handToMouthFrames = 0, kptFrames = 0;
    let noseDropMax = 0, noseDropWindowOk = false;
    const heights = samples.map(s => Math.max(0.05, s.box.y2 - s.box.y1));
    const refHeight = Math.max(...heights); // рост в полный размер — для нормировки падения

    for (let si = 1; si < samples.length; si++) {
      const a = samples[si - 1], b = samples[si];
      if (!a.kpts || !b.kpts) continue;
      const dt = Math.max(0.05, (b.t - a.t) / 1000);
      const h = heights[si];
      for (const wi of [K.lwrist, K.rwrist]) {
        const ka = a.kpts[wi], kb = b.kpts[wi];
        if (ka.c > 0.3 && kb.c > 0.3) {
          const v = distA(ka, kb, aspect) / dt / h;
          if (v > wristMax) { wristMax = v; wristMaxFrame = b.frame; }
        }
      }
    }

    // падение носа: макс. суммарное проседание в скользящем окне ≤1.2с
    // (реальное падение при 4 fps размазано на 2-4 кадра)
    const noseSeries = samples
      .filter(s => s.kpts && s.kpts[K.nose].c > 0.3)
      .map(s => ({ y: s.kpts[K.nose].y, t: s.t }));
    for (let i = 0; i < noseSeries.length; i++) {
      for (let j = i + 1; j < noseSeries.length; j++) {
        if (noseSeries[j].t - noseSeries[i].t > 1200) break;
        const drop = (noseSeries[j].y - noseSeries[i].y) / refHeight;
        if (drop > noseDropMax) noseDropMax = drop;
      }
    }

    for (const s of samples) {
      if (!s.kpts) continue;
      const nose = s.kpts[K.nose];
      if (nose.c > 0.3) {
        kptFrames++;
        const headSize = Math.max(0.02, distA(s.kpts[K.lshoulder], s.kpts[K.rshoulder], aspect) * 0.7);
        for (const wi of [K.lwrist, K.rwrist]) {
          const w = s.kpts[wi];
          if (w.c > 0.3 && distA(w, nose, aspect) < headSize * 0.65) { handToMouthFrames++; break; }
        }
      }
    }

    const last = samples[samples.length - 1];
    const lastStatic = staticHints({ ...last.box, kpts: last.kpts, conf: 1 }, aspect);
    const endsDown = lastStatic.some(h => h.type === 'fall');

    // ПАДЕНИЕ (динамика): голова просела ≥0.35 роста за ≤1.2с И в конце лежит/низко
    if (noseDropMax >= 0.35 && endsDown) {
      hints.push({ type: 'fall', trackId: +id, detail: `резкое падение: голова просела на ${(noseDropMax * 100) | 0}% роста, в конце лежит` });
      frameActivity[last.frame] += 5;
      noseDropWindowOk = true;
    } else if (endsDown) {
      hints.push({ type: 'fall', trackId: +id, detail: lastStatic.find(h => h.type === 'fall').detail });
      frameActivity[last.frame] += 3;
    }

    // КУРЕНИЕ: рука у рта в ≥3 кадрах и ≥50% видимых
    if (handToMouthFrames >= 3 && handToMouthFrames >= kptFrames * 0.5) {
      hints.push({ type: 'hand_to_mouth', trackId: +id, detail: `рука у рта удерживается ${handToMouthFrames} кадров подряд (жест курения/вейпа)` });
      frameActivity[Math.floor(N / 2)] += 2;
    }

    if (wristMax > maxWristSpeed) maxWristSpeed = wristMax;
    trackStats[id] = { wristMax, wristMaxFrame, samples };
    if (wristMax >= 1.0) frameActivity[wristMaxFrame] += 3;
  }

  // ДРАКА: пара треков вплотную (< 0.9 роста) в ≥2 кадрах И у кого-то резкие руки (≥1.0 h/s)
  const ids = Object.keys(seq);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = seq[ids[i]], B = seq[ids[j]];
      let closeFrames = 0, closeAt = 0;
      for (const sa of A) {
        const sb = B.find(x => x.frame === sa.frame);
        if (!sb) continue;
        const size = Math.max(sa.box.y2 - sa.box.y1, sb.box.y2 - sb.box.y1);
        if (distA(center(sa.box), center(sb.box), aspect) < size * 0.9) { closeFrames++; closeAt = sa.frame; }
      }
      const sharp = Math.max(trackStats[ids[i]]?.wristMax || 0, trackStats[ids[j]]?.wristMax || 0);
      if (closeFrames >= 2 && sharp >= 1.0) {
        hints.push({ type: 'fight_signal', detail: `двое вплотную ${closeFrames} кадров + удар/замах ${sharp.toFixed(1)} роста/сек` });
        const punchFrame = (trackStats[ids[i]]?.wristMax || 0) >= (trackStats[ids[j]]?.wristMax || 0)
          ? trackStats[ids[i]]?.wristMaxFrame : trackStats[ids[j]]?.wristMaxFrame;
        frameActivity[punchFrame ?? closeAt] += 5;
      }
    }
  }

  const uniq = [];
  for (const h of hints) if (!uniq.some(u => u.type === h.type && u.trackId === h.trackId)) uniq.push(h);

  let bestFrameIdx = Math.floor(N / 2);
  let bestScore = -1;
  for (let i = 0; i < N; i++) if (frameActivity[i] > bestScore) { bestScore = frameActivity[i]; bestFrameIdx = i; }

  const calm = ids.length > 0 && maxWristSpeed < 0.3 && uniq.length === 0;
  return { hints: uniq, calm, wristSpeed: maxWristSpeed, bestFrameIdx, tracks: Object.keys(seq).length };
}
