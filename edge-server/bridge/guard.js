// guard.js — предохранители денег (v7.3).
//
// Причина появления: статичная «угроза» (сумка на подоконнике) зациклила
// режим наблюдения и молотила облако каждые 2-5 секунд бесконечно.
//
// Два механизма:
// 1) Отпечаток сцены — если набор объектов и их позиции не изменились с
//    момента последнего облачного анализа, нового знания облако не даст.
//    Пропускаем вызов. Перепроверка статики — раз в STATIC_RECHECK_MIN.
// 2) Жёсткий потолок вызовов на камеру в час — страховка от ЛЮБОЙ будущей
//    ошибки логики. Деньги важнее гордости: даже если я снова ошибусь,
//    счёт не улетит.

/**
 * Отпечаток сцены: классы объектов + центры, округлённые до сетки 5% кадра.
 * Микро-дрожание детектора не меняет отпечаток; реальное перемещение — меняет.
 * Порядок детекций не важен (сортируем).
 */
export function buildSceneFp(dets, possibleFire = false) {
  if (!Array.isArray(dets)) return 'na';
  const parts = dets.map(d => {
    const cx = Math.round(((d.x1 + d.x2) / 2) * 20); // сетка 5%
    const cy = Math.round(((d.y1 + d.y2) / 2) * 20);
    return `${d.cls}:${cx}x${cy}`;
  });
  parts.sort();
  if (possibleFire) parts.push('~fire');
  return parts.join('|') || 'empty';
}

/** Почасовой лимит облачных вызовов на камеру. */
export class CloudBudget {
  constructor(maxPerHour = 60) {
    this.max = Math.max(1, maxPerHour | 0);
    this.s = {};
  }
  /** @returns {{ok:boolean, n:number, firstDenial?:boolean}} */
  take(camId, now = Date.now()) {
    let st = this.s[camId];
    if (!st || now - st.start >= 3600000) {
      st = this.s[camId] = { start: now, n: 0, warned: false };
    }
    if (st.n >= this.max) {
      const firstDenial = !st.warned;
      st.warned = true;
      return { ok: false, firstDenial, n: st.n };
    }
    st.n++;
    return { ok: true, n: st.n };
  }
  /** Меняет потолок, НЕ сбрасывая уже потраченное за текущий час. */
  setMax(maxPerHour) {
    this.max = Math.max(1, maxPerHour | 0);
  }
  count(camId) { return this.s[camId] ? this.s[camId].n : 0; }
}
