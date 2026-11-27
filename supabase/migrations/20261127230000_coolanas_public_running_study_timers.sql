create or replace function public.coolanas_public_running_timers(p_limit integer default 100)
returns table(user_id uuid,username text,avatar_url text,elapsed_ms bigint,started_at timestamptz,server_now timestamptz)
language sql stable security definer set search_path = public, auth
as $$
  select p.id,p.username,
    coalesce(u.raw_user_meta_data->>'avatar_url',u.raw_user_meta_data->>'picture'),
    greatest(0,coalesce(sw.elapsed_ms,0)+case when sw.started_at is not null then greatest(0,(extract(epoch from (clock_timestamp()-sw.started_at))*1000)::bigint) else 0 end),
    sw.started_at,clock_timestamp()
  from public.coolanas_account_stopwatches sw
  join public.profiles p on p.id=sw.user_id
  join auth.users u on u.id=sw.user_id
  where auth.uid() is not null and p.username is not null and sw.started_at is not null
  order by sw.started_at asc,p.username asc
  limit least(greatest(coalesce(p_limit,100),1),500);
$$;
revoke all on function public.coolanas_public_running_timers(integer) from public, anon;
grant execute on function public.coolanas_public_running_timers(integer) to authenticated;
