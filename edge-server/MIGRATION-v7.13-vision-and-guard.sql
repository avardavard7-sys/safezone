-- Облачные проверки через платформу и контроль камеры.
-- Уже применено к проекту safezone (ноябрь 2026); файл оставлен для истории и для развёртывания на другом сервере.

create table if not exists public.bridge_vision_usage (
  bridge_id uuid not null references public.bridges(id) on delete cascade,
  hour timestamptz not null,
  calls integer not null default 0,
  primary key (bridge_id, hour)
);
alter table public.bridge_vision_usage enable row level security;
revoke all on public.bridge_vision_usage from anon, authenticated;

create or replace function public.bridge_vision_gate(bridge_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b record;
  n integer;
  hourly_limit constant integer := 600;
begin
  select * into b from bridges where token = bridge_token;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  if b.access_state <> 'active' or (b.access_until is not null and b.access_until <= now()) then
    return jsonb_build_object('ok', false, 'reason', 'access');
  end if;
  insert into bridge_vision_usage (bridge_id, hour, calls)
  values (b.id, date_trunc('hour', now()), 1)
  on conflict (bridge_id, hour) do update set calls = bridge_vision_usage.calls + 1
  returning calls into n;
  if n > hourly_limit then
    return jsonb_build_object('ok', false, 'reason', 'budget', 'calls', n);
  end if;
  delete from bridge_vision_usage where hour < now() - interval '7 days';
  return jsonb_build_object('ok', true, 'calls', n);
end;
$$;

revoke execute on function public.bridge_vision_gate(text) from public;
grant execute on function public.bridge_vision_gate(text) to anon, authenticated, service_role;

alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check check (type = any (array[
  'theft', 'fight', 'crowd', 'fire', 'smoking', 'child_lost', 'escalator', 'violation', 'suspicious', 'fall', 'access',
  'vandalism', 'weapon', 'abandoned_object', 'loitering', 'uncleaned_table', 'no_staff', 'empty_zone', 'occupied',
  'concealment', 'cash_suspicious', 'blacklist_match', 'queue_long', 'camera_moved', 'camera_blocked'
]::text[]));
