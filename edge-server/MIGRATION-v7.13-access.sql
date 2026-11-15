-- Доступ клиента: пауза, срок, лимит камер и сообщение.
-- Менять эти поля может только разработчик: так уже устроены права на таблицу bridges.

alter table public.bridges
  add column if not exists access_state text not null default 'active',
  add column if not exists access_until timestamptz,
  add column if not exists max_cameras integer,
  add column if not exists access_message text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bridges_access_state_check') then
    alter table public.bridges add constraint bridges_access_state_check check (access_state in ('active', 'paused', 'revoked'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bridges_max_cameras_check') then
    alter table public.bridges add constraint bridges_max_cameras_check check (max_cameras is null or max_cameras >= 0);
  end if;
end $$;

create or replace function public.bridge_heartbeat(bridge_token text, s jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b record;
  access jsonb;
  active boolean;
begin
  select * into b from bridges where token = bridge_token;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'бридж не найден, нужна повторная привязка');
  end if;
  update bridges set last_seen_at = now(), status = 'online', stats = s where id = b.id;
  delete from blacklist_entries where mall_id = b.mall_id and expires_at < now();

  access := jsonb_build_object(
    'state', b.access_state,
    'until', b.access_until,
    'max_cameras', b.max_cameras,
    'message', b.access_message
  );
  active := b.access_state = 'active' and (b.access_until is null or b.access_until > now());

  -- без доступа бридж не получает настройки объекта и токен Telegram
  if not active then
    return jsonb_build_object('ok', true, 'access', access);
  end if;
  return jsonb_build_object('ok', true, 'access', access) || bridge_object_payload(b.mall_id);
end;
$$;
