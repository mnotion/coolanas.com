create table if not exists public.coolanas_bazaar_simulated_timers (
  id uuid primary key,
  run_id text not null,
  username text not null,
  avatar_url text,
  elapsed_ms bigint not null default 0 check (elapsed_ms >= 0),
  started_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.coolanas_bazaar_simulated_timers enable row level security;
revoke all on public.coolanas_bazaar_simulated_timers from public, anon, authenticated;

insert into public.coolanas_bazaar_simulated_timers
  (id,run_id,username,elapsed_ms,started_at)
select
  md5('bazaar-sim-45-20261127-' || n::text)::uuid,
  'bazaar-sim-45-20261127',
  'test_user_' || lpad(n::text,2,'0'),
  0,
  clock_timestamp() - make_interval(secs => n * 13)
from generate_series(1,45) as n
on conflict (id) do nothing;

create or replace function public.coolanas_public_running_timers(p_limit integer default 100)
returns table(user_id uuid,username text,avatar_url text,elapsed_ms bigint,started_at timestamptz,server_now timestamptz)
language sql stable security definer set search_path = public, auth
as $$
  select p.id,p.username,
    coalesce(u.raw_user_meta_data->>'avatar_url',u.raw_user_meta_data->>'picture'),
    greatest(0,coalesce(sw.elapsed_ms,0)),sw.started_at,statement_timestamp()
  from public.coolanas_account_stopwatches sw
  join public.profiles p on p.id=sw.user_id
  join auth.users u on u.id=sw.user_id
  where auth.uid() is not null and p.username is not null and sw.started_at is not null
  union all
  select sim.id,sim.username,sim.avatar_url,sim.elapsed_ms,sim.started_at,statement_timestamp()
  from public.coolanas_bazaar_simulated_timers sim
  where auth.uid() is not null and sim.run_id='bazaar-sim-45-20261127'
  order by started_at asc,username asc
  limit least(greatest(coalesce(p_limit,100),1),500);
$$;
revoke all on function public.coolanas_public_running_timers(integer) from public, anon;
grant execute on function public.coolanas_public_running_timers(integer) to authenticated;
