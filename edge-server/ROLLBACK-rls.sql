-- 🚨 ОТКАТ RLS — выполнить в Supabase SQL Editor, если панель перестала работать.
-- Возвращает базу в состояние ДО включения защиты. Данные не трогает.
-- После отката напиши, что именно сломалось — починим политику точечно.

alter table profiles            disable row level security;
alter table malls               disable row level security;
alter table cameras             disable row level security;
alter table zones               disable row level security;
alter table events              disable row level security;
alter table tenants             disable row level security;
alter table violations          disable row level security;
alter table visitor_counts      disable row level security;
alter table telegram_settings   disable row level security;
alter table camera_frames       disable row level security;
alter table heatmap_points      disable row level security;
alter table visitor_events      disable row level security;
alter table violation_templates disable row level security;
alter table audit_logs          disable row level security;
alter table bridge_settings     disable row level security;

notify pgrst, 'reload schema';
