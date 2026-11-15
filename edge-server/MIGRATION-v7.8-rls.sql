-- MIGRATION v7.8 — RLS. УЖЕ ПРИМЕНЕНА к cejwgfwmyzofnezqwbgu 01.08.2026.
-- Файл для других объектов. Откат: ROLLBACK-rls.sql
--
-- Что было: RLS отключён на 12 таблицах — любой с публичным anon-ключом
-- читал и менял ВСЁ, включая cameras.password и telegram_settings.bot_token.
--
-- Важно: в базе УЖЕ были грамотные политики от разработчика панели
-- (is_developer() / current_user_mall_id(), обе SECURITY DEFINER).
-- Они просто не работали, пока RLS был выключен. Мы достроили недостающие
-- в ТОМ ЖЕ стиле, а не завели второй, конфликтующий набор.

-- Таблицы, у которых политик не было вовсе:
do $$
declare t text;
begin
  foreach t in array array[
    'camera_frames','heatmap_points','telegram_settings',
    'visitor_counts','visitor_events','bridge_settings'
  ] loop
    execute format('drop policy if exists %I_rw on public.%I', t, t);
    execute format($f$
      create policy %I_rw on public.%I for all to authenticated
        using (is_developer() or mall_id = current_user_mall_id())
        with check (is_developer() or mall_id = current_user_mall_id())
    $f$, t, t);
  end loop;
end $$;

drop policy if exists violation_templates_rw on violation_templates;
create policy violation_templates_rw on violation_templates for all to authenticated
  using (is_developer() or mall_id is null or mall_id = current_user_mall_id())
  with check (is_developer() or mall_id = current_user_mall_id());

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or is_developer() or mall_id = current_user_mall_id());
drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_insert_own on profiles;
create policy profiles_insert_own on profiles for insert to authenticated
  with check (id = auth.uid());

drop policy if exists malls_select on malls;
create policy malls_select on malls for select to authenticated using (true);
drop policy if exists malls_update on malls;
create policy malls_update on malls for update to authenticated
  using (is_developer() or id = current_user_mall_id())
  with check (is_developer() or id = current_user_mall_id());
drop policy if exists malls_insert on malls;
create policy malls_insert on malls for insert to authenticated
  with check (is_developer() or current_user_mall_id() is null);

drop policy if exists audit_logs_insert on audit_logs;
create policy audit_logs_insert on audit_logs for insert to authenticated
  with check (user_id is null or user_id = auth.uid());

-- Включение
alter table profiles enable row level security;
alter table malls enable row level security;
alter table cameras enable row level security;
alter table zones enable row level security;
alter table events enable row level security;
alter table tenants enable row level security;
alter table violations enable row level security;
alter table visitor_counts enable row level security;
alter table telegram_settings enable row level security;
alter table camera_frames enable row level security;
alter table heatmap_points enable row level security;
alter table visitor_events enable row level security;
alter table violation_templates enable row level security;
alter table audit_logs enable row level security;
alter table bridge_settings enable row level security;

notify pgrst, 'reload schema';
