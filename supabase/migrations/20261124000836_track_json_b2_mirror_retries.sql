alter table public.coolanas_dashboard_data
  add column if not exists settings_b2_mirror_pending boolean not null default false,
  add column if not exists analytics_b2_mirror_pending boolean not null default false;
