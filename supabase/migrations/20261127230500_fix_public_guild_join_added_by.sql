create or replace function public.coolanas_guild_join_public(p_guild_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if not exists(select 1 from public.coolanas_guilds where id=p_guild_id and is_public=true) then
  raise exception 'This Guild is not available to join';
 end if;
 if exists(select 1 from public.coolanas_guild_members where guild_id=p_guild_id and user_id=auth.uid()) then
  return true;
 end if;
 insert into public.coolanas_guild_members(guild_id,user_id,added_by,role)
 values(p_guild_id,auth.uid(),auth.uid(),'member');
 return true;
end;
$function$;
