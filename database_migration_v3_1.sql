-- ===========================================================================
-- SafeZone v3.1 — AI настройки в Settings
-- Добавляет настройки AI в malls + per-camera ai_enabled
-- Безопасно выполнять повторно
-- ===========================================================================

-- Per-mall настройки AI
ALTER TABLE malls ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE malls ADD COLUMN IF NOT EXISTS ai_interval_sec INTEGER DEFAULT 15;
ALTER TABLE malls ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(3,2) DEFAULT 0.5;
ALTER TABLE malls ADD COLUMN IF NOT EXISTS ai_cooldown_sec INTEGER DEFAULT 60;

-- Per-camera включение AI
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN DEFAULT TRUE;

-- Существующим записям ставим разумные дефолты
UPDATE malls SET ai_enabled = TRUE WHERE ai_enabled IS NULL;
UPDATE malls SET ai_interval_sec = 15 WHERE ai_interval_sec IS NULL;
UPDATE malls SET ai_confidence = 0.5 WHERE ai_confidence IS NULL;
UPDATE malls SET ai_cooldown_sec = 60 WHERE ai_cooldown_sec IS NULL;
UPDATE cameras SET ai_enabled = TRUE WHERE ai_enabled IS NULL;

SELECT 'SafeZone v3.1 AI settings migration OK!' AS status;
