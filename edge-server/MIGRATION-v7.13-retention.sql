-- Срок хранения снимков и событий.
-- Снимок с людьми — персональные данные: хранить его дольше, чем нужно для разбора события, нельзя.
-- Запускать в Supabase → SQL Editor. Перед запуском проверьте сроки в двух строках ниже.

create table if not exists retention_settings (
  id boolean primary key default true check (id),
  screenshot_days integer not null default 30 check (screenshot_days between 1 and 3650),
  event_days integer not null default 365 check (event_days between 1 and 3650)
);
insert into retention_settings (id) values (true) on conflict (id) do nothing;
alter table retention_settings enable row level security;

create or replace function apply_retention()
returns table (screenshots_cleared bigint, events_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  s retention_settings%rowtype;
  cleared bigint;
  deleted bigint;
begin
  select * into s from retention_settings where id;
  update events set screenshot_base64 = null
   where screenshot_base64 is not null
     and created_at < now() - make_interval(days => s.screenshot_days);
  get diagnostics cleared = row_count;
  delete from events where created_at < now() - make_interval(days => s.event_days);
  get diagnostics deleted = row_count;
  return query select cleared, deleted;
end;
$$;

revoke all on function apply_retention() from public, anon, authenticated;

-- Ежедневный запуск в 03:00 UTC. Нужно расширение pg_cron: Database → Extensions → pg_cron.
-- select cron.schedule('safezone-retention', '0 3 * * *', $$select apply_retention()$$);

-- Проверка вручную, без расписания:
-- select * from apply_retention();
