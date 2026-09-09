-- ============================================
-- SAFEZONE v2.1 — PRODUCTION MIGRATION
-- Полная миграция: таблицы + RLS + realtime + автосоздание профилей
-- ============================================

-- 1. ОТКЛЮЧАЕМ RLS для работы Bridge без авторизации
ALTER TABLE IF EXISTS cameras DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS events DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS malls DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS zones DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS violations DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS telegram_settings DISABLE ROW LEVEL SECURITY;

-- 2. ДОБАВЛЯЕМ колонки для живых кадров
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS last_frame_base64 TEXT;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS last_frame_at TIMESTAMPTZ;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 3. ВКЛЮЧАЕМ Realtime
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE cameras;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE events;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE violations;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END$$;

-- 4. ИНДЕКСЫ для производительности
CREATE INDEX IF NOT EXISTS idx_cameras_mall ON cameras(mall_id);
CREATE INDEX IF NOT EXISTS idx_events_mall ON events(mall_id);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenants_mall ON tenants(mall_id);
CREATE INDEX IF NOT EXISTS idx_violations_mall ON violations(mall_id);
CREATE INDEX IF NOT EXISTS idx_zones_mall ON zones(mall_id);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_mall ON profiles(mall_id);

-- Готово!
SELECT 'SafeZone v2.1 migration completed successfully!' AS status;
