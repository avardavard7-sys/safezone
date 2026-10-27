-- MIGRATION v7.7 — УЖЕ ПРИМЕНЕНА к проекту cejwgfwmyzofnezqwbgu 01.08.2026.
-- Файл оставлен для других объектов/клиентов. Безопасно повторять.

-- ═══ 1. Настройки функций бриджа из панели ═══
create table if not exists bridge_settings (
  mall_id    uuid primary key references malls(id) on delete cascade,
  config     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into bridge_settings (mall_id, config)
select id, '{}'::jsonb from malls
on conflict (mall_id) do nothing;

-- ═══ 2. КРИТИЧНО: events.type отвергал реальные типы бриджа ═══
-- 'weapon' (нож/оружие) падал на CHECK и НЕ сохранялся — дыра в охранной системе.
alter table events drop constraint if exists events_type_check;
alter table events add constraint events_type_check check (type = any (array[
  'theft','fight','crowd','fire','smoking','child_lost','escalator',
  'violation','suspicious','fall','access','vandalism',
  'weapon','abandoned_object','loitering',
  'uncleaned_table','no_staff','empty_zone','occupied'
]));

-- ═══ 3. zone_id (из v7.3) и индексы под дашборд ═══
alter table events add column if not exists zone_id uuid;
create index if not exists events_mall_created_idx on events (mall_id, created_at desc);
create index if not exists events_camera_created_idx on events (camera_id, created_at desc);
create index if not exists events_status_idx on events (status) where status = 'new';
create index if not exists cameras_mall_active_idx on cameras (mall_id, is_active);

notify pgrst, 'reload schema';
