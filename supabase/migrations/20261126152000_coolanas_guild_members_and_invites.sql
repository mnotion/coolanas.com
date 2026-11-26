create table if not exists public.coolanas_guilds (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null unique references auth.users(id) on delete cascade,
 name text not null default 'Guild' check (char_length(name) between 1 and 80),
 created_at timestamptz not null default now()
);
create table if not exists public.coolanas_guild_members (
 id uuid primary key default gen_random_uuid(),
 guild_id uuid not null references public.coolanas_guilds(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 added_by uuid not null references auth.users(id),
 joined_at timestamptz not null default now(),
 unique (guild_id,user_id)
);
create index if not exists coolanas_guild_members_user_idx on public.coolanas_guild_members(user_id);
alter table public.coolanas_guilds enable row level security;
alter table public.coolanas_guild_members enable row level security;
revoke all on public.coolanas_guilds, public.coolanas_guild_members from public, anon, authenticated;
create or replace function public.coolanas_guild_get_or_create()
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_guild public.coolanas_guilds%rowtype; v_members jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 insert into public.coolanas_guilds(owner_id) values(auth.uid()) on conflict(owner_id) do nothing;
 select * into v_guild from public.coolanas_guilds where owner_id=auth.uid();
 insert into public.coolanas_guild_members(guild_id,user_id,added_by)
 values(v_guild.id,auth.uid(),auth.uid()) on conflict(guild_id,user_id) do nothing;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'username',coalesce(p.username,'User')) order by lower(coalesce(p.username,'User'))),'[]'::jsonb)
 into v_members from public.coolanas_guild_members gm join public.profiles p on p.id=gm.user_id
 where gm.guild_id=v_guild.id;
 return jsonb_build_object('id',v_guild.id,'name',v_guild.name,'owner_id',v_guild.owner_id,'members',v_members);
end;
$$;
create or replace function public.coolanas_guild_add_member(p_username text)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_guild public.coolanas_guilds%rowtype; v_target uuid; v_username text;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_username is null or char_length(trim(p_username))<4 then raise exception 'Enter a valid username'; end if;
 select * into v_guild from public.coolanas_guilds where owner_id=auth.uid();
 if not found then raise exception 'Your Guild is not ready yet'; end if;
 select p.id,p.username into v_target,v_username from public.profiles p
 where lower(p.username)=lower(trim(p_username)) limit 1;
 if v_target is null then raise exception 'No account found with that username'; end if;
 if v_target=auth.uid() then raise exception 'You are already in this Guild'; end if;
 insert into public.coolanas_guild_members(guild_id,user_id,added_by)
 values(v_guild.id,v_target,auth.uid()) on conflict(guild_id,user_id) do nothing;
 return jsonb_build_object('id',v_target,'username',v_username);
end;
$$;
revoke all on function public.coolanas_guild_get_or_create() from public,anon;
revoke all on function public.coolanas_guild_add_member(text) from public,anon;
grant execute on function public.coolanas_guild_get_or_create() to authenticated;
grant execute on function public.coolanas_guild_add_member(text) to authenticated;