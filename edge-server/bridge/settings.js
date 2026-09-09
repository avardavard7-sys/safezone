// settings.js — живые настройки бриджа (v7.7).
//
// Было: всё через .env — чтобы поменять порог, клиент лез в докер и пересобирал.
// Стало: панель пишет в Supabase, бридж подхватывает на следующем цикле (~5 сек).
//
// Приоритет: значение из БД → значение из .env → жёсткий дефолт.
// Если таблицы нет или колонка отсутствует — молча работаем на .env, как раньше.
// Ничего не ломается: пустая БД = поведение v7.6 один в один.

/** Описание всех настроек: тип, дефолт, нужен ли перезапуск, для UI панели */
export const SCHEMA = {
  // ── Детектор (перезапуск: модели грузятся при старте) ──
  DETECTOR:            { type: 'enum', values: ['yolox_s','yolox_nano','yolox_m','yolox_l','yolov8n'], def: 'yolox_s', restart: true,  group: 'Детектор', label: 'Модель детектора' },
  POSE_MODEL:          { type: 'enum', values: ['rtmo_m','yolov8n-pose'], def: 'rtmo_m',               restart: true,  group: 'Детектор', label: 'Модель скелетов' },
  YOLO_ENABLED:        { type: 'bool', def: true,  restart: false, group: 'Детектор', label: 'Локальный фильтр YOLO', hint: 'Выключить = каждый кадр уходит в облако. Дорого!' },
  MOTION_ENABLED:      { type: 'bool', def: true,  restart: false, group: 'Детектор', label: 'Детектор движения' },
  MOTION_THRESHOLD:    { type: 'num',  def: 0.4, min: 0.05, max: 5, step: 0.05, restart: false, group: 'Детектор', label: 'Порог движения, %' },

  // ── Динамика ──
  LOCAL_TRACKER:       { type: 'bool', def: true, restart: false, group: 'Динамика', label: 'Трекер объектов', hint: 'ID людей и сумок, скорости, топтание, брошенные вещи — локально, $0' },
  LOITER_SEC:          { type: 'int',  def: 180, min: 30, max: 3600, restart: false, group: 'Динамика', label: 'Топтание на месте, сек' },
  ABANDONED_LOCAL_SEC: { type: 'int',  def: 45,  min: 10, max: 3600, restart: false, group: 'Динамика', label: 'Брошенная вещь, сек' },
  BURST_ENABLED:       { type: 'bool', def: true, restart: false, group: 'Динамика', label: 'Серия кадров при тревоге', hint: 'Анализ движения (удар, падение) до вызова облака' },
  BURST_FRAMES:        { type: 'int',  def: 8, min: 3, max: 16, restart: false, group: 'Динамика', label: 'Кадров в серии' },
  BURST_FPS:           { type: 'int',  def: 4, min: 1, max: 15, restart: false, group: 'Динамика', label: 'Частота серии, к/с' },

  // ── Предохранители денег ──
  MAX_CLOUD_PER_CAM_HOUR: { type: 'int', def: 60, min: 1, max: 3600, restart: false, group: 'Экономия', label: 'Лимит облака на камеру в час', hint: 'Жёсткий потолок. Защищает от петель и неожиданных счетов' },
  STATIC_RECHECK_MIN:     { type: 'int', def: 15, min: 1, max: 240,  restart: false, group: 'Экономия', label: 'Перепроверка статики, мин', hint: 'Неизменившаяся сцена не отправляется в облако чаще этого' },

  // ── Дальнозоркость ──
  TILED_DETECT:  { type: 'enum', values: ['off','auto','always'], def: 'auto', restart: false, group: 'Дальнозоркость', label: 'Тайловый проход', hint: 'auto = сканирует пустую сцену; always = каждый кадр (грузит процессор)' },
  TILED_GRID:    { type: 'int', def: 2, min: 2, max: 4, restart: false, group: 'Дальнозоркость', label: 'Сетка тайлов', hint: '2×2 видит людей до ~48px, 3×3 до ~37px' },
  TILED_EVERY_N: { type: 'int', def: 5, min: 1, max: 60, restart: false, group: 'Дальнозоркость', label: 'Сканировать раз в N циклов' },

  // ── Зоны сервиса ──
  ZONES_ENABLED:  { type: 'bool', def: true, restart: false, group: 'Зоны', label: 'Правила зон', hint: 'Бармен на месте, посуда убрана — локально, $0' },
  ZONE_GRACE_SEC: { type: 'int',  def: 15, min: 0, max: 120, restart: false, group: 'Зоны', label: 'Анти-дребезг, сек', hint: 'Условие считается нарушенным только если ложно дольше этого' },
  DISH_CLASSES:   { type: 'str',  def: 'cup,bowl,wine glass,bottle', restart: false, group: 'Зоны', label: 'Что считать посудой' },

  // ── Приватность и режим ──
  LOCAL_ONLY:        { type: 'bool', def: false, restart: false, group: 'Приватность', label: 'Только локально (без облака)', hint: 'Кадры НЕ покидают объект. Нужна локальная VLM, иначе описания сцен не будет' },
  AFTER_HOURS_START: { type: 'time', def: '22:00', restart: false, group: 'Приватность', label: 'Ночной режим с' },
  AFTER_HOURS_END:   { type: 'time', def: '06:00', restart: false, group: 'Приватность', label: 'Ночной режим до' },
};

const truthy = v => v === true || v === 'true' || v === 1 || v === '1';

/** Приводит значение к типу схемы и зажимает в границы. Мусор → null (возьмём дефолт). */
export function coerce(key, raw) {
  const s = SCHEMA[key];
  if (!s || raw === undefined || raw === null || raw === '') return null;
  switch (s.type) {
    case 'bool': return truthy(raw) || raw === false || raw === 'false' ? truthy(raw) : null;
    case 'int': {
      const n = parseInt(raw);
      if (!Number.isFinite(n)) return null;
      return Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, n));
    }
    case 'num': {
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return null;
      return Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, n));
    }
    case 'enum': return s.values.includes(String(raw)) ? String(raw) : null;
    case 'time': return /^\d{1,2}:\d{2}$/.test(String(raw)) ? String(raw) : null;
    default: return String(raw);
  }
}

/**
 * Собирает рабочий конфиг: БД поверх .env поверх дефолтов.
 * @param {object} env      process.env
 * @param {object} dbConfig JSONB из bridge_settings.config (может быть null)
 */
export function buildConfig(env = {}, dbConfig = null) {
  const out = {};
  for (const [key, s] of Object.entries(SCHEMA)) {
    const fromDb = dbConfig ? coerce(key, dbConfig[key]) : null;
    const fromEnv = coerce(key, env[key]);
    out[key] = fromDb !== null ? fromDb : (fromEnv !== null ? fromEnv : s.def);
  }
  return out;
}

/** Что изменилось между конфигами — для лога и для побочных эффектов */
export function diffConfig(oldCfg, newCfg) {
  const changed = [];
  for (const key of Object.keys(SCHEMA)) {
    if (String(oldCfg?.[key]) !== String(newCfg?.[key])) {
      changed.push({ key, from: oldCfg?.[key], to: newCfg?.[key], restart: SCHEMA[key].restart });
    }
  }
  return changed;
}

/** Схема для UI панели: группы в порядке появления */
export function uiSchema() {
  const groups = {};
  for (const [key, s] of Object.entries(SCHEMA)) {
    (groups[s.group] = groups[s.group] || []).push({ key, ...s });
  }
  return groups;
}
