create or replace function public.coolanas_guild_get_or_create()
returns jsonb
language plpgsql
security definer
set search_path=public,auth
as $$
declare v_guild public.coolanas_guilds%rowtype; v_members jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 select g.* into v_guild
 from public.coolanas_guild_members gm
 join public.coolanas_guilds g on g.id=gm.guild_id
 where gm.user_id=auth.uid()
 order by gm.joined_at desc
 limit 1;
 if not found then
  insert into public.coolanas_guilds(owner_id) values(auth.uid())
  on conflict(owner_id) do nothing;
  select * into v_guild from public.coolanas_guilds where owner_id=auth.uid();
  insert into public.coolanas_guild_members(guild_id,user_id,added_by)
  values(v_guild.id,auth.uid(),auth.uid()) on conflict(guild_id,user_id) do nothing;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'username',coalesce(p.username,'User')) order by lower(coalesce(p.username,'User'))),'[]'::jsonb)
 into v_members
 from public.coolanas_guild_members gm
 join public.profiles p on p.id=gm.user_id
 where gm.guild_id=v_guild.id;
 return jsonb_build_object('id',v_guild.id,'name',v_guild.name,'owner_id',v_guild.owner_id,'members',v_members);
end;
$$;
revoke all on function public.coolanas_guild_get_or_create() from public,anon;
grant execute on function public.coolanas_guild_get_or_create() to authenticated;