-- MIGRATION v7.3: колонка zone_id в events (бридж пишет её для зон ювелирки и будущих полигонов)
-- Выполнить в Supabase → SQL Editor → Run. Безопасно повторять.
ALTER TABLE events ADD COLUMN IF NOT EXISTS zone_id uuid;
-- сброс кэша схемы PostgREST, чтобы колонку увидели сразу:
NOTIFY pgrst, 'reload schema';
