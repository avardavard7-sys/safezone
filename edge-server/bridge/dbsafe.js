// dbsafe.js — вставка в БД, устойчивая к дрейфу схемы (v7.3.1).
//
// Причина: код бриджа обновляется, а таблицы у клиентов могут отставать
// (у Адама events без zone_id → PGRST204 → события ТЕРЯЛИСЬ, хотя Telegram шёл).
// Теперь: ловим "колонка X не найдена", выкидываем X из пейлоада, повторяем.
// Событие сохраняется с тем, что схема принимает; в лог — совет применить миграцию.

const warned = new Set();

// Типы, которые база гарантированно принимает (CHECK на events.type).
// Если схема у клиента старая и новый тип отвергнут — падаем сюда, а не теряем событие.
const SAFE_TYPE_FALLBACK = {
  weapon: 'suspicious', abandoned_object: 'suspicious', loitering: 'suspicious',
  uncleaned_table: 'violation', no_staff: 'violation',
  empty_zone: 'violation', occupied: 'suspicious',
};

/**
 * @param {object} sb       клиент supabase
 * @param {string} table
 * @param {object} payload
 * @param {function} log
 * @returns {Promise<{error: object|null, dropped: string[]}>}
 */
export async function insertDroppingUnknownColumns(sb, table, payload, log = console.log) {
  const p = { ...payload };
  const dropped = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await sb.from(table).insert(p);
    if (!error) return { error: null, dropped };
    // (а) отсутствующая колонка → повторяем без неё
    const m = error.code === 'PGRST204' && /Could not find the '([^']+)' column/.exec(error.message || '');
    if (m && m[1] in p) {
      const col = m[1];
      delete p[col];
      dropped.push(col);
      const key = `${table}.${col}`;
      if (!warned.has(key)) {
        warned.add(key);
        log(`  ⚠️ Схема БД отстала: в таблице "${table}" нет колонки "${col}" — событие сохранено без неё. Примени миграцию.`);
      }
      continue;
    }

    // (б) тип не проходит CHECK (старая схема) → подставляем разрешённый и НЕ теряем событие.
    // Иначе тревога уходит в Telegram, а в базе её нет — дашборд слепой.
    const isCheck = error.code === '23514' || /violates check constraint|check constraint/i.test(error.message || '');
    if (isCheck && p.type && SAFE_TYPE_FALLBACK[p.type]) {
      const from = p.type;
      p.type = SAFE_TYPE_FALLBACK[from];
      p.description = `[${from}] ${p.description || ''}`.trim();
      dropped.push(`type:${from}→${p.type}`);
      const key = `${table}.type.${from}`;
      if (!warned.has(key)) {
        warned.add(key);
        log(`  ⚠️ База не принимает тип "${from}" — сохраняю как "${p.type}". Примени MIGRATION-v7.7-settings.sql, чтобы типы писались корректно.`);
      }
      continue;
    }

    return { error, dropped }; // не схемная проблема — отдаём как есть
  }
  return { error: { message: 'слишком много отсутствующих колонок' }, dropped };
}
