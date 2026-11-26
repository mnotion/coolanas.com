insert into public.coolanas_guild_invitations(guild_id,invited_user_id,invited_by,status,created_at)
select gm.guild_id,gm.user_id,coalesce(gm.added_by,g.owner_id),'pending',now()
from public.coolanas_guild_members gm join public.coolanas_guilds g on g.id=gm.guild_id
where gm.user_id<>g.owner_id
on conflict(guild_id,invited_user_id) do update
set invited_by=excluded.invited_by,status='pending',created_at=now(),responded_at=null;
delete from public.coolanas_guild_members gm using public.coolanas_guilds g
where g.id=gm.guild_id and gm.user_id<>g.owner_id;