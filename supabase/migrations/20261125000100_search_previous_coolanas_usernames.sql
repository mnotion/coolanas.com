create table if not exists public.coolanas_username_history (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 username text not null,
 changed_at timestamptz not null default now(),
 constraint coolanas_username_history_user_name_unique unique(user_id,username)
);
create index if not exists coolanas_username_history_username_lower_idx on public.coolanas_username_history(lower(username));
alter table public.coolanas_username_history enable row level security;
revoke all on public.coolanas_username_history from public,anon,authenticated;
create or replace function public.coolanas_track_username_change()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
 if old.username is distinct from new.username and nullif(trim(old.username),'') is not null then
  insert into public.coolanas_username_history(user_id,username)
  values(new.id,trim(old.username))
  on conflict(user_id,username) do nothing;
 end if;
 return new;
end;
$$;
drop trigger if exists coolanas_track_username_change on public.profiles;
create trigger coolanas_track_username_change
before update of username on public.profiles
for each row execute function public.coolanas_track_username_change();
drop function if exists public.coolanas_friend_search(text);
create function public.coolanas_friend_search(p_query text)
returns table(user_id uuid, username text, google_avatar text, friendship_status text, matched_username text)
language sql security definer set search_path=public,auth
as $$
 with matched as (
  select p.id,p.username,
   coalesce(u.raw_user_meta_data->>'avatar_url',u.raw_user_meta_data->>'picture') as google_avatar,
   (select f.status from public.coolanas_friendships f
    where ((f.requester_id=auth.uid() and f.recipient_id=p.id) or (f.requester_id=p.id and f.recipient_id=auth.uid()))
      and f.status='pending' order by f.created_at desc limit 1) as friendship_status,
   coalesce(
    case when lower(p.username)=lower(trim(p_query)) then p.username end,
    (select h.username from public.coolanas_username_history h
      where h.user_id=p.id and lower(h.username)=lower(trim(p_query))
      order by h.changed_at desc limit 1),
    p.username
   ) as matched_username
  from public.profiles p join auth.users u on u.id=p.id
  where auth.uid() is not null and p.id<>auth.uid() and p.username is not null
   and length(trim(coalesce(p_query,'')))>=2
   and (
    p.username ilike '%' || replace(replace(trim(p_query),'%','\\%'),'_','\\_') || '%'
    or exists(select 1 from public.coolanas_username_history h where h.user_id=p.id
      and h.username ilike '%' || replace(replace(trim(p_query),'%','\\%'),'_','\\_') || '%')
   )
   and not exists(select 1 from public.coolanas_friendships f
    where f.status='accepted' and ((f.requester_id=auth.uid() and f.recipient_id=p.id) or (f.requester_id=p.id and f.recipient_id=auth.uid())))
 )
 select * from matched
 order by (lower(matched_username)=lower(trim(p_query))) desc,
          (lower(username)=lower(trim(p_query))) desc,lower(username)
 limit 20;
$$;
revoke all on function public.coolanas_friend_search(text) from public,anon;
grant execute on function public.coolanas_friend_search(text) to authenticated;
