create table if not exists public.coolanas_guild_invitations (
 id uuid primary key default gen_random_uuid(),
 guild_id uuid not null references public.coolanas_guilds(id) on delete cascade,
 invited_user_id uuid not null references auth.users(id) on delete cascade,
 invited_by uuid not null references auth.users(id) on delete cascade,
 status text not null default 'pending' check(status in ('pending','accepted','declined')),
 created_at timestamptz not null default now(), responded_at timestamptz,
 unique(guild_id,invited_user_id)
);
create index if not exists coolanas_guild_invites_recipient_idx on public.coolanas_guild_invitations(invited_user_id,status,created_at desc);
alter table public.coolanas_guild_invitations enable row level security;
revoke all on public.coolanas_guild_invitations from public,anon,authenticated;
create or replace function public.coolanas_guild_invite_user(p_username text)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_guild public.coolanas_guilds%rowtype; v_target uuid; v_username text; v_invite uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_username is null or char_length(trim(p_username))<4 then raise exception 'Enter a valid username'; end if;
 select * into v_guild from public.coolanas_guilds where owner_id=auth.uid();
 if not found then raise exception 'Only the Guild owner can invite members'; end if;
 select p.id,p.username into v_target,v_username from public.profiles p where lower(p.username)=lower(trim(p_username)) limit 1;
 if v_target is null then raise exception 'No account found with that username'; end if;
 if v_target=auth.uid() then raise exception 'You are already in this Guild'; end if;
 if exists(select 1 from public.coolanas_guild_members where guild_id=v_guild.id and user_id=v_target) then raise exception 'That user is already a Guild member'; end if;
 insert into public.coolanas_guild_invitations(guild_id,invited_user_id,invited_by,status,responded_at)
 values(v_guild.id,v_target,auth.uid(),'pending',null)
 on conflict(guild_id,invited_user_id) do update set invited_by=excluded.invited_by,status='pending',created_at=now(),responded_at=null
 returning id into v_invite;
 return jsonb_build_object('id',v_invite,'username',v_username,'status','pending');
end; $$;
create or replace function public.coolanas_guild_list_invitations()
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_incoming jsonb; v_outgoing jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'guild_id',g.id,'guild_name',g.name,'invited_by',i.invited_by,'inviter_username',coalesce(p.username,'Coolanas user'),'created_at',i.created_at) order by i.created_at desc),'[]'::jsonb)
 into v_incoming from public.coolanas_guild_invitations i join public.coolanas_guilds g on g.id=i.guild_id left join public.profiles p on p.id=i.invited_by where i.invited_user_id=auth.uid() and i.status='pending';
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'guild_id',g.id,'username',coalesce(p.username,'Coolanas user'),'created_at',i.created_at) order by i.created_at desc),'[]'::jsonb)
 into v_outgoing from public.coolanas_guild_invitations i join public.coolanas_guilds g on g.id=i.guild_id left join public.profiles p on p.id=i.invited_user_id where i.invited_by=auth.uid() and i.status='pending';
 return jsonb_build_object('incoming',v_incoming,'outgoing',v_outgoing);
end; $$;
create or replace function public.coolanas_guild_respond_invitation(p_invitation_id uuid,p_accept boolean)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_invite public.coolanas_guild_invitations%rowtype; v_name text;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 select * into v_invite from public.coolanas_guild_invitations where id=p_invitation_id and invited_user_id=auth.uid() and status='pending' for update;
 if not found then raise exception 'This Guild invitation is no longer pending'; end if;
 if p_accept then
  insert into public.coolanas_guild_members(guild_id,user_id,added_by) values(v_invite.guild_id,auth.uid(),v_invite.invited_by) on conflict(guild_id,user_id) do nothing;
  update public.coolanas_guild_invitations set status='accepted',responded_at=now() where id=v_invite.id;
  select name into v_name from public.coolanas_guilds where id=v_invite.guild_id;
  return jsonb_build_object('accepted',true,'guild_id',v_invite.guild_id,'guild_name',v_name);
 else
  update public.coolanas_guild_invitations set status='declined',responded_at=now() where id=v_invite.id;
  return jsonb_build_object('accepted',false);
 end if;
end; $$;
create or replace function public.coolanas_guild_add_member(p_username text)
returns jsonb language sql security definer set search_path=public,auth as $$ select public.coolanas_guild_invite_user(p_username); $$;
revoke all on function public.coolanas_guild_invite_user(text) from public,anon;
revoke all on function public.coolanas_guild_list_invitations() from public,anon;
revoke all on function public.coolanas_guild_respond_invitation(uuid,boolean) from public,anon;
revoke all on function public.coolanas_guild_add_member(text) from public,anon;
grant execute on function public.coolanas_guild_invite_user(text) to authenticated;
grant execute on function public.coolanas_guild_list_invitations() to authenticated;
grant execute on function public.coolanas_guild_respond_invitation(uuid,boolean) to authenticated;
grant execute on function public.coolanas_guild_add_member(text) to authenticated;