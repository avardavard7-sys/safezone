// zones.js — правила зон на таймерах (v7.5). ПОЛНОСТЬЮ ЛОКАЛЬНО, $0.
//
// Ни один вызов облака: только детекции YOLO + геометрия полигонов + таймеры.
// Именно так это делают в индустрии (Roboflow: детекция → зоны → таймеры → алерт).
//
// Правила:
//   no_staff   — гость в зоне гостей, а в зоне персонала никого N секунд
//   uncleaned  — посуда в зоне стола, людей нет N секунд («убрать со стола»)
//   empty_zone — в зоне никого N секунд (пост без сотрудника)
//   occupied   — в зоне кто-то находится дольше N секунд (очередь, топтание)
//
// Анти-дребезг: детектор моргает (чашка пропала на кадр). Условие считается
// нарушенным, только если оно ложно дольше grace_sec — иначе таймер на 5 минут
// никогда бы не досчитал.

const DEFAULT_GRACE_SEC = 15;

/** Точка внутри полигона (ray casting). poly: [[x,y],...] в норм. координатах 0..1 */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Опорная точка детекции: 'bottom' — ноги/основание (по умолчанию), 'center' — центр */
export function anchorOf(det, anchor = 'bottom') {
  const cx = (det.x1 + det.x2) / 2;
  return anchor === 'center' ? { x: cx, y: (det.y1 + det.y2) / 2 } : { x: cx, y: det.y2 };
}

/** Есть ли в полигоне детекция нужных классов */
export function anyInZone(dets, poly, classes, anchor = 'bottom') {
  if (!poly || poly.length < 3) return false;
  for (const d of dets) {
    if (classes && !classes.includes(d.cls)) continue;
    const p = anchorOf(d, anchor);
    if (pointInPolygon(p.x, p.y, poly)) return true;
  }
  return false;
}

export function countInZone(dets, poly, classes, anchor = 'bottom') {
  if (!poly || poly.length < 3) return 0;
  let n = 0;
  for (const d of dets) {
    if (classes && !classes.includes(d.cls)) continue;
    const p = anchorOf(d, anchor);
    if (pointInPolygon(p.x, p.y, poly)) n++;
  }
  return n;
}

/** Выполняется ли условие правила ПРЯМО СЕЙЧАС */
export function evalRule(rule, dets, dishClasses) {
  const anchor = rule.anchor || 'bottom';
  const dishes = rule.dish_classes || dishClasses;
  switch (rule.rule) {
    case 'no_staff': {
      const guest = anyInZone(dets, rule.guest_zone, ['person'], anchor);
      const staff = anyInZone(dets, rule.staff_zone, ['person'], anchor);
      return guest && !staff;
    }
    case 'uncleaned': {
      const dishesPresent = anyInZone(dets, rule.zone, dishes, anchor);
      const people = anyInZone(dets, rule.zone, ['person'], anchor);
      return dishesPresent && !people;
    }
    case 'empty_zone':
      return !anyInZone(dets, rule.zone, ['person'], anchor);
    case 'occupied':
      return countInZone(dets, rule.zone, ['person'], anchor) >= (rule.min_people || 1);
    default:
      return false;
  }
}

/** Человекочитаемый текст тревоги */
function describe(rule, seconds) {
  const mins = Math.round(seconds / 60);
  const t = mins >= 1 ? `${mins} мин` : `${Math.round(seconds)} сек`;
  switch (rule.rule) {
    case 'no_staff':   return `${rule.name}: гость ждёт уже ${t} — сотрудника нет на месте`;
    case 'uncleaned':  return `${rule.name}: посуда не убрана ${t} — стол свободен, нужна уборка`;
    case 'empty_zone': return `${rule.name}: пост без сотрудника ${t}`;
    case 'occupied':   return `${rule.name}: люди в зоне уже ${t}`;
    default:           return `${rule.name}: условие держится ${t}`;
  }
}

export class ZoneEngine {
  /**
   * @param {Array} rules       правила из zones.json
   * @param {object} opts       { dishClasses, graceSec }
   */
  constructor(rules = [], opts = {}) {
    this.rules = rules;
    this.dishClasses = opts.dishClasses || ['cup', 'bowl', 'wine glass', 'bottle'];
    this.graceSec = opts.graceSec ?? DEFAULT_GRACE_SEC;
    this.state = {}; // ruleId → { since, lastAlertAt, brokenSince }
  }

  rulesFor(cam) {
    return this.rules.filter(r => {
      if (r.enabled === false) return false;
      const key = String(r.camera ?? '').toLowerCase();
      return !key || key === String(cam.id).toLowerCase() || key === String(cam.name || '').toLowerCase();
    });
  }

  /**
   * Прогон правил камеры. Возвращает СРАБОТАВШИЕ тревоги (уже с учётом
   * времени удержания и интервала повтора).
   * @returns {Array<{ruleId, name, type, severity, description, seconds}>}
   */
  evaluate(cam, dets, now = Date.now()) {
    const fired = [];
    for (const rule of this.rulesFor(cam)) {
      const id = `${cam.id}:${rule.id}`;
      const st = (this.state[id] = this.state[id] || { since: null, lastAlertAt: null, brokenSince: null });
      const cond = evalRule(rule, dets, this.dishClasses);
      const holdMs = (rule.seconds ?? 300) * 1000;
      const repeatMs = (rule.repeat_sec ?? rule.seconds ?? 300) * 1000;

      if (cond) {
        st.brokenSince = null;
        if (!st.since) st.since = now;
        const elapsed = now - st.since;
        if (elapsed >= holdMs && (!st.lastAlertAt || now - st.lastAlertAt >= repeatMs)) {
          st.lastAlertAt = now;
          fired.push({
            ruleId: rule.id,
            name: rule.name,
            type: rule.event_type || (rule.rule === 'uncleaned' ? 'uncleaned_table' : 'no_staff'),
            severity: rule.severity || 'low',
            description: describe(rule, elapsed / 1000),
            seconds: Math.round(elapsed / 1000),
          });
        }
      } else {
        // анти-дребезг: сбрасываем таймер только если условие ложно дольше grace
        if (!st.brokenSince) st.brokenSince = now;
        if (now - st.brokenSince >= this.graceSec * 1000) {
          st.since = null; st.lastAlertAt = null; st.brokenSince = null;
        }
      }
    }
    return fired;
  }

  /** Диагностика для логов: что сейчас «тикает» */
  pending(cam, now = Date.now()) {
    const out = [];
    for (const rule of this.rulesFor(cam)) {
      const st = this.state[`${cam.id}:${rule.id}`];
      if (st && st.since) out.push({ name: rule.name, sec: Math.round((now - st.since) / 1000), need: rule.seconds ?? 300 });
    }
    return out;
  }
}
