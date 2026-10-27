-- ============================================
-- SAFEZONE — миграция v2.3: AI-события из вебкамеры
-- Безопасно выполнять повторно (IF NOT EXISTS)
-- ============================================

-- Добавляем поля в events, если их ещё нет
ALTER TABLE events ADD COLUMN IF NOT EXISTS screenshot_base64 TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS people_count INTEGER;
ALTER TABLE events ADD COLUMN IF NOT EXISTS confidence NUMERIC(3,2);
ALTER TABLE events ADD COLUMN IF NOT EXISTS camera_name TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS floor INTEGER;

SELECT 'SafeZone v2.3 migration OK!' AS status;
