alter table public.coolanas_dashboard_data
  add column if not exists task_days jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.coolanas_dashboard_data'::regclass
      and conname = 'coolanas_dashboard_data_task_days_array_check'
  ) then
    alter table public.coolanas_dashboard_data
      add constraint coolanas_dashboard_data_task_days_array_check
      check (jsonb_typeof(task_days) = 'array');
  end if;
end $$;
