create or replace function public.coolanas_public_usernames()
returns table(username text)
language sql
stable
security definer
set search_path = public
as $$
  select p.username
  from public.profiles p
  where p.username is not null and length(trim(p.username)) > 0
  order by lower(p.username), p.username;
$$;
revoke all on function public.coolanas_public_usernames() from public, anon;
grant execute on function public.coolanas_public_usernames() to authenticated;
