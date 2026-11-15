-- ============================================================
-- SafeZone — добавление выбора сценариев угроз для каждой камеры
-- Выполнить в Supabase: SQL Editor → New query → вставить → Run
-- ============================================================

-- Добавляем колонку enabled_scenarios (массив ключей угроз)
ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS enabled_scenarios jsonb
  DEFAULT '["fire","weapon","fight","theft","fall","smoking","intrusion","crowd","child_lost","suspicious"]'::jsonb;

-- Для уже существующих камер проставляем все сценарии по умолчанию (если null)
UPDATE cameras
  SET enabled_scenarios = '["fire","weapon","fight","theft","fall","smoking","intrusion","crowd","child_lost","suspicious"]'::jsonb
  WHERE enabled_scenarios IS NULL;
