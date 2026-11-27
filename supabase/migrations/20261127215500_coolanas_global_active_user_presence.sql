create table if not exists public.coolanas_user_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default clock_timestamp()
);
alter table public.coolanas_user_presence enable row level security;
revoke all on public.coolanas_user_presence from anon, authenticated;

create or replace function public.coolanas_set_user_presence()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  insert into public.coolanas_user_presence(user_id,last_seen_at)
  values(auth.uid(),clock_timestamp())
  on conflict(user_id) do update set last_seen_at=excluded.last_seen_at;
end;
$$;

create or replace function public.coolanas_active_users(p_limit integer default 20,p_offset integer default 0)
returns table(user_id uuid,username text,avatar_url text)
language sql
stable
security definer
set search_path = public, auth
as $$
  select p.id,p.username,
    coalesce(u.raw_user_meta_data->>'avatar_url',u.raw_user_meta_data->>'picture') as avatar_url
  from public.coolanas_user_presence presence
  join public.profiles p on p.id=presence.user_id
  join auth.users u on u.id=p.id
  where auth.uid() is not null
    and p.username is not null
    and presence.last_seen_at >= clock_timestamp() - interval '90 seconds'
  order by presence.last_seen_at desc,p.username asc
  limit least(greatest(coalesce(p_limit,20),1),20)
  offset greatest(coalesce(p_offset,0),0);
$$;

revoke all on function public.coolanas_set_user_presence() from public, anon;
revoke all on function public.coolanas_active_users(integer,integer) from public, anon;
grant execute on function public.coolanas_set_user_presence() to authenticated;
grant execute on function public.coolanas_active_users(integer,integer) to authenticated;
