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
    and presence.last_seen_at >= now() - interval '90 seconds'
  order by p.username asc,p.id asc
  limit least(greatest(coalesce(p_limit,20),1),20)
  offset greatest(coalesce(p_offset,0),0);
$$;
