-- MIGRATION v7.9 — очередь команд панель→бридж.
-- УЖЕ ПРИМЕНЕНА к cejwgfwmyzofnezqwbgu 01.08.2026. Файл для других объектов.
--
-- Зачем: браузер клиента не может стучаться на http://127.0.0.1 с https-страницы
-- (mixed content), а давать клиенту исходники панели для локального запуска нельзя.
-- Решение: панель кладёт команду в базу, бридж забирает её на своём цикле.

create table if not exists bridge_commands (
  id          uuid primary key default gen_random_uuid(),
  mall_id     uuid not null references malls(id) on delete cascade,
  kind        text not null check (kind in ('discover','probe')),
  params      jsonb not null default '{}'::jsonb,
  status      text not null default 'pending' check (status in ('pending','running','done','error')),
  result      jsonb,
  error       text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

create index if not exists bridge_commands_pending_idx
  on bridge_commands (mall_id, created_at) where status = 'pending';
create index if not exists bridge_commands_recent_idx
  on bridge_commands (mall_id, created_at desc);

alter table bridge_commands enable row level security;
drop policy if exists bridge_commands_rw on bridge_commands;
create policy bridge_commands_rw on bridge_commands for all to authenticated
  using (is_developer() or mall_id = current_user_mall_id())
  with check (is_developer() or mall_id = current_user_mall_id());

create or replace function public.cleanup_bridge_commands()
returns void language sql security definer set search_path = public as $$
  delete from public.bridge_commands where created_at < now() - interval '1 day';
$$;

notify pgrst, 'reload schema';
