-- ===========================================================================
-- SafeZone v3.0 — Production migration
-- Audit logs + Row Level Security + индексы
-- Безопасно выполнять повторно
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- AUDIT LOGS — логирование действий пользователей
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  username TEXT,
  mall_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_mall_id ON audit_logs (mall_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);

-- Авто-чистка логов старше 90 дней (опционально, через pg_cron в Supabase Pro)
-- SELECT cron.schedule('cleanup-audit-logs', '0 3 * * *',
--   $$DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '90 days'$$);

-- ---------------------------------------------------------------------------
-- ИНДЕКСЫ для производительности
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_events_mall_id_created_at ON events (mall_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events (severity);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);
CREATE INDEX IF NOT EXISTS idx_events_camera_id ON events (camera_id);
CREATE INDEX IF NOT EXISTS idx_cameras_mall_id ON cameras (mall_id);
CREATE INDEX IF NOT EXISTS idx_cameras_is_active ON cameras (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_profiles_mall_id ON profiles (mall_id);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles (username);
CREATE INDEX IF NOT EXISTS idx_violations_mall_id ON violations (mall_id);
CREATE INDEX IF NOT EXISTS idx_tenants_mall_id ON tenants (mall_id);
CREATE INDEX IF NOT EXISTS idx_zones_mall_id ON zones (mall_id);

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY — изоляция данных между ТРЦ
-- ---------------------------------------------------------------------------

-- Helper-функция: достать mall_id текущего пользователя
CREATE OR REPLACE FUNCTION current_user_mall_id() RETURNS UUID AS $$
  SELECT mall_id FROM profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Helper: developer/admin-режим
CREATE OR REPLACE FUNCTION is_developer() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND (role = 'developer' OR username = 'hodkonem')
      AND is_approved = true
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Включаем RLS
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- ----- EVENTS -----
DROP POLICY IF EXISTS "events_select" ON events;
CREATE POLICY "events_select" ON events FOR SELECT USING (
  is_developer() OR mall_id = current_user_mall_id()
);
DROP POLICY IF EXISTS "events_insert" ON events;
CREATE POLICY "events_insert" ON events FOR INSERT WITH CHECK (
  is_developer() OR mall_id = current_user_mall_id()
);
DROP POLICY IF EXISTS "events_update" ON events;
CREATE POLICY "events_update" ON events FOR UPDATE USING (
  is_developer() OR mall_id = current_user_mall_id()
);
DROP POLICY IF EXISTS "events_delete" ON events;
CREATE POLICY "events_delete" ON events FOR DELETE USING (
  is_developer() OR mall_id = current_user_mall_id()
);

-- ----- CAMERAS -----
DROP POLICY IF EXISTS "cameras_all" ON cameras;
CREATE POLICY "cameras_all" ON cameras FOR ALL USING (
  is_developer() OR mall_id = current_user_mall_id()
) WITH CHECK (
  is_developer() OR mall_id = current_user_mall_id()
);

-- ----- TENANTS -----
DROP POLICY IF EXISTS "tenants_all" ON tenants;
CREATE POLICY "tenants_all" ON tenants FOR ALL USING (
  is_developer() OR mall_id = current_user_mall_id()
) WITH CHECK (
  is_developer() OR mall_id = current_user_mall_id()
);

-- ----- VIOLATIONS -----
DROP POLICY IF EXISTS "violations_all" ON violations;
CREATE POLICY "violations_all" ON violations FOR ALL USING (
  is_developer() OR mall_id = current_user_mall_id()
) WITH CHECK (
  is_developer() OR mall_id = current_user_mall_id()
);

-- ----- ZONES -----
DROP POLICY IF EXISTS "zones_all" ON zones;
CREATE POLICY "zones_all" ON zones FOR ALL USING (
  is_developer() OR mall_id = current_user_mall_id()
) WITH CHECK (
  is_developer() OR mall_id = current_user_mall_id()
);

-- ----- AUDIT LOGS — только developer читает -----
DROP POLICY IF EXISTS "audit_select" ON audit_logs;
CREATE POLICY "audit_select" ON audit_logs FOR SELECT USING (
  is_developer() OR mall_id = current_user_mall_id()
);
DROP POLICY IF EXISTS "audit_insert_service" ON audit_logs;
-- INSERT через service_role обходит RLS, политика для anon-вставок не нужна

SELECT 'SafeZone v3.0 production migration OK!' AS status;
