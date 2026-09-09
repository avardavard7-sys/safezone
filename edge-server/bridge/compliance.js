/**
 * Пункты регламента видеоконтроля.
 *
 * Панель отдаёт список проверок при привязке и на каждом heartbeat. Здесь он
 * превращается в расписание: что считать локально и бесплатно, а что и когда
 * отправлять в облако.
 *
 * Локальные проверки (engine: 'local') облако не трогают вообще — их считает
 * движок зон и детектор. Облачные (engine: 'cloud') идут по интервалу из
 * регламента: раз в 30 минут значит раз в 30 минут, а не каждый цикл.
 */

const MIN = 60_000;

export class ComplianceSchedule {
  constructor(checks = []) {
    this.replace(checks);
  }

  /** Принимает список от панели. Расписание уже прошедших проверок сохраняется. */
  replace(checks) {
    const prev = this.lastRun || {};
    this.checks = (Array.isArray(checks) ? checks : []).filter(c => c && c.code);
    const alive = new Set(this.checks.map(c => c.code));
    // ключ расписания — "код@камера": переносим только те, чей пункт ещё включён.
    // Иначе heartbeat каждые 5 секунд обнулял бы интервалы и слал снимки в облако
    // на каждом цикле вместо раза в 30 минут.
    this.lastRun = {};
    for (const [key, at] of Object.entries(prev)) {
      if (alive.has(key.split('@')[0])) this.lastRun[key] = at;
    }
    return this;
  }

  get size() { return this.checks.length; }

  /** Проверки, которые бридж считает сам: облако не участвует, $0. */
  localChecks() {
    return this.checks.filter(c => c.engine === 'local');
  }

  /** Локальные правила в формате движка зон — так их уже умеет считать zones.js. */
  toZoneRules() {
    return this.localChecks()
      .filter(c => c.rule_kind === 'uncleaned' || c.rule_kind === 'no_staff')
      .map(c => ({
        id: `compliance:${c.code}`,
        name: c.title,
        camera: c.camera_id || null,
        rule: c.rule_kind,
        seconds: c.threshold_sec || 300,
        severity: c.severity || 'medium',
        enabled: true,
      }));
  }

  /** Ищем ли телефон в руках сотрудника — детектор уже знает этот класс. */
  watchesPhone() {
    return this.localChecks().some(c => c.rule_kind === 'phone_use');
  }

  /**
   * Проверки, которым пора сработать для этой камеры.
   * mode 'continuous' — каждый цикл, 'snapshot' — раз в interval_min.
   */
  due(cameraId, now = Date.now()) {
    return this.checks.filter(c => {
      if (c.engine === 'local') return false;          // считается без облака
      if (c.camera_id && c.camera_id !== cameraId) return false;
      if (c.mode === 'continuous') return true;
      const key = `${c.code}@${cameraId}`;
      const last = this.lastRun[key];
      if (last === undefined) return true;             // первый раз — сразу
      return now - last >= (c.interval_min || 30) * MIN;
    });
  }

  /** Отмечает, что проверки отработали — следующий раз не раньше интервала. */
  markRun(cameraId, checks, now = Date.now()) {
    for (const c of checks) {
      if (c.mode === 'snapshot') this.lastRun[`${c.code}@${cameraId}`] = now;
    }
  }

  /** Через сколько минут ближайшая проверка по этой камере. Для логов. */
  nextInMinutes(cameraId, now = Date.now()) {
    let soonest = null;
    for (const c of this.checks) {
      if (c.engine === 'local' || c.mode !== 'snapshot') continue;
      if (c.camera_id && c.camera_id !== cameraId) continue;
      const last = this.lastRun[`${c.code}@${cameraId}`];
      const wait = last === undefined ? 0 : (c.interval_min || 30) * MIN - (now - last);
      const m = Math.max(0, Math.ceil(wait / MIN));
      if (soonest === null || m < soonest) soonest = m;
    }
    return soonest;
  }

  /** Добавка к промпту: что именно смотреть в этом кадре. */
  promptFor(checks) {
    const lines = checks
      .filter(c => c.hint)
      .map(c => `[${c.code}] ${c.title}\n${c.hint}`);
    if (!lines.length) return '';
    return (
      '\n\n═══ ПРОВЕРКИ РЕГЛАМЕНТА ═══\n' +
      'Пройди КАЖДЫЙ пункт ниже отдельно и дай по нему однозначный вывод.\n' +
      'Правила ответа:\n' +
      '- нарушение создавай только по тому, что видно в кадре отчётливо;\n' +
      '- в описании пиши КОНКРЕТНО что и где: не «беспорядок», а «на столе у окна\n' +
      '  две чашки и салфетки»; не «форма не по стандарту», а «у сотрудника слева\n' +
      '  нет головного убора»;\n' +
      '- если объект перекрыт, обрезан кадром или виден со спины — так и напиши,\n' +
      '  не угадывай и нарушение не создавай;\n' +
      '- если по пункту всё в порядке — нарушение не создавай;\n' +
      '- в поле code укажи номер пункта из списка.\n\n' +
      lines.join('\n\n')
    );
  }

  /** Короткая строка для стартового баннера. */
  summary() {
    const loc = this.localChecks().length;
    const cloud = this.checks.length - loc;
    if (!this.checks.length) return 'нет активных пунктов';
    return `${this.checks.length} пунктов: ${loc} локально ($0), ${cloud} по расписанию`;
  }
}
