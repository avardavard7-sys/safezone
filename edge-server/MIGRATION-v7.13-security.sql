-- Исправления безопасности по отчёту Supabase (ноябрь 2026).
-- Закрывает функции и представление, которые отвечали без входа.

revoke execute on function public.bridge_object_payload(uuid) from public, anon, authenticated;
revoke execute on function public.bridge_compliance(uuid) from public, anon, authenticated;
revoke execute on function public.bridge_count_lines(uuid) from public, anon, authenticated;
revoke execute on function public.business_day_start(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.cleanup_bridge_commands() from public, anon, authenticated;
revoke execute on function public.purge_expired_blacklist() from public, anon, authenticated;
grant execute on function public.bridge_object_payload(uuid), public.bridge_compliance(uuid), public.bridge_count_lines(uuid),
  public.business_day_start(uuid, timestamptz), public.cleanup_bridge_commands(), public.purge_expired_blacklist() to service_role;

revoke execute on function public.object_features(uuid) from public, anon;
grant execute on function public.object_features(uuid) to authenticated, service_role;

revoke execute on function public.mark_stale_bridges() from public, anon;
grant execute on function public.mark_stale_bridges() to authenticated, service_role;

alter view public.visitors_hourly set (security_invoker = true);
revoke all on public.visitors_hourly from anon;
revoke insert, update, delete, truncate, references, trigger on public.visitors_hourly from authenticated;

create or replace function public.is_developer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'developer' and is_approved = true
  );
$$;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('generate_act_number', 'auto_fill_violation', 'auto_generate_violation_from_event',
                        'update_zone_visitors', 'gen_pairing_code', 'guard_mall_profile', 'guard_event_review')
  loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;
