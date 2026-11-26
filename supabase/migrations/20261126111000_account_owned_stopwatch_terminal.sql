begin;

create table if not exists public.coolanas_account_stopwatches (
  user_id uuid primary key references auth.users(id) on delete cascade,
  elapsed_ms bigint not null default 0 check (elapsed_ms >= 0),
  started_at timestamptz,
  started_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  version bigint not null default 0 check (version >= 0)
);

alter table public.coolanas_account_stopwatches enable row level security;

drop policy if exists "Users can read their own stopwatch" on public.coolanas_account_stopwatches;
create policy "Users can read their own stopwatch"
  on public.coolanas_account_stopwatches
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own stopwatch" on public.coolanas_account_stopwatches;
create policy "Users can create their own stopwatch"
  on public.coolanas_account_stopwatches
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own stopwatch" on public.coolanas_account_stopwatches;
create policy "Users can update their own stopwatch"
  on public.coolanas_account_stopwatches
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all privileges on table public.coolanas_account_stopwatches from public, anon, authenticated;
grant select, insert, update on table public.coolanas_account_stopwatches to authenticated;
grant all privileges on table public.coolanas_account_stopwatches to service_role;

-- Carry forward an active session only to the account that started it.
-- A stopped global timer may contain several people's combined time, so it
-- is intentionally not copied into any individual account.
insert into public.coolanas_account_stopwatches
  (user_id, elapsed_ms, started_at, started_by, updated_at, updated_by, version)
select g.started_by, g.elapsed_ms, g.started_at, g.started_by,
       g.updated_at, g.started_by, 1
from public.coolanas_guild_stopwatch g
join auth.users u on u.id = g.started_by
where g.id = true and g.started_at is not null and g.started_by is not null
on conflict (user_id) do nothing;

create or replace function public.coolanas_account_stopwatch_action(p_action text)
returns table (
  elapsed_ms bigint,
  started_at timestamptz,
  started_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version bigint,
  server_now timestamptz,
  previous_started_at timestamptz,
  action_changed boolean
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_row public.coolanas_account_stopwatches%rowtype;
  v_now timestamptz;
  v_previous_started_at timestamptz;
  v_action_changed boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_action not in ('get', 'start', 'pause', 'reset') then
    raise exception 'Invalid stopwatch action';
  end if;

  insert into public.coolanas_account_stopwatches (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  select s.*
    into v_row
  from public.coolanas_account_stopwatches s
  where s.user_id = v_user_id
  for update;

  if not found then
    raise exception 'Stopwatch terminal could not be initialised';
  end if;

  v_now := clock_timestamp();
  v_previous_started_at := v_row.started_at;

  if p_action = 'start' then
    if v_row.started_at is null then
      update public.coolanas_account_stopwatches s
      set started_at = v_now,
          started_by = v_user_id,
          updated_at = v_now,
          updated_by = v_user_id,
          version = s.version + 1
      where s.user_id = v_user_id
      returning s.* into v_row;
      v_action_changed := true;
    end if;
  elsif p_action = 'pause' then
    if v_row.started_at is not null then
      update public.coolanas_account_stopwatches s
      set elapsed_ms = s.elapsed_ms +
            greatest(0, floor(extract(epoch from (v_now - s.started_at)) * 1000)::bigint),
          started_at = null,
          started_by = null,
          updated_at = v_now,
          updated_by = v_user_id,
          version = s.version + 1
      where s.user_id = v_user_id
      returning s.* into v_row;
      v_action_changed := true;
    end if;
  elsif p_action = 'reset' then
    if v_row.elapsed_ms <> 0 or v_row.started_at is not null then
      update public.coolanas_account_stopwatches s
      set elapsed_ms = 0,
          started_at = null,
          started_by = null,
          updated_at = v_now,
          updated_by = v_user_id,
          version = s.version + 1
      where s.user_id = v_user_id
      returning s.* into v_row;
      v_action_changed := true;
    end if;
  end if;

  return query
  select v_row.elapsed_ms,
         v_row.started_at,
         v_row.started_by,
         v_row.updated_at,
         v_row.updated_by,
         v_row.version,
         v_now,
         v_previous_started_at,
         v_action_changed;
end;
$function$;

revoke all on function public.coolanas_account_stopwatch_action(text) from public, anon, authenticated;
grant execute on function public.coolanas_account_stopwatch_action(text) to authenticated;

-- Retire access to the old singleton timer. Its combined state must not be
-- visible to every account once the account-owned terminal is live.
drop policy if exists "Authenticated users can view guild stopwatch"
  on public.coolanas_guild_stopwatch;
revoke all privileges on table public.coolanas_guild_stopwatch from public, anon, authenticated;
revoke all on function public.coolanas_guild_stopwatch_action(text) from public, anon, authenticated;

do $publication$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'coolanas_account_stopwatches'
  ) then
    alter publication supabase_realtime
      add table public.coolanas_account_stopwatches;
  end if;
end;
$publication$;

commit;
