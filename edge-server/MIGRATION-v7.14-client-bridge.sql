create or replace function public.dev_create_bridge(p_mall uuid, p_name text default 'Бридж')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  m_name text;
  c text;
  b_id uuid;
  exp timestamptz := now() + interval '24 hours';
begin
  if not is_developer() then
    raise exception 'код бриджа для клиента выдаёт только разработчик';
  end if;

  select name into m_name from malls where id = p_mall;
  if m_name is null then
    raise exception 'объект не найден';
  end if;

  loop
    c := gen_pairing_code();
    exit when not exists (select 1 from bridges where pairing_code = c);
  end loop;

  select id into b_id from bridges
   where mall_id = p_mall and auth_user_id is null and paired_at is null
   limit 1;

  if b_id is null then
    insert into bridges (mall_id, name, pairing_code, code_expires, created_by)
    values (p_mall, coalesce(nullif(trim(p_name), ''), 'Бридж'), c, exp, auth.uid())
    returning id into b_id;
  else
    update bridges set pairing_code = c, code_expires = exp where id = b_id;
  end if;

  return jsonb_build_object(
    'id', b_id,
    'pairing_code', c,
    'code_expires', exp,
    'mall_id', p_mall,
    'mall_name', m_name
  );
end $$;

revoke all on function public.dev_create_bridge(uuid, text) from public, anon;
grant execute on function public.dev_create_bridge(uuid, text) to authenticated;
