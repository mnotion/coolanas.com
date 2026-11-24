alter table public.coolanas_dashboard_data
  add column if not exists settings_json jsonb,
  add column if not exists settings_b2_migrated boolean not null default false,
  add column if not exists settings_b2_checked_at timestamptz,
  add column if not exists analytics_json jsonb,
  add column if not exists analytics_b2_migrated boolean not null default false,
  add column if not exists analytics_b2_checked_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.coolanas_dashboard_data'::regclass
      and conname = 'coolanas_dashboard_data_settings_json_object_check'
  ) then
    alter table public.coolanas_dashboard_data
      add constraint coolanas_dashboard_data_settings_json_object_check
      check (settings_json is null or jsonb_typeof(settings_json) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.coolanas_dashboard_data'::regclass
      and conname = 'coolanas_dashboard_data_analytics_json_object_check'
  ) then
    alter table public.coolanas_dashboard_data
      add constraint coolanas_dashboard_data_analytics_json_object_check
      check (analytics_json is null or jsonb_typeof(analytics_json) = 'object');
  end if;
end $$;
