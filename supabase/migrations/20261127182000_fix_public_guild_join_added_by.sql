-- Public Guild joins must record the joining user as the actor.
-- The membership table requires added_by to be non-null.
create or replace function public.coolanas_guild_join_public(p_guild_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_guild public.coolanas_guilds%rowtype;
  v_inserted integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
    into v_guild
    from public.coolanas_guilds
   where id = p_guild_id;

  if not found then
    raise exception 'This Guild could not be found';
  end if;

  -- Read the visibility flag from the row so this migration remains
  -- compatible with installations where Guild metadata was added separately.
  if coalesce((to_jsonb(v_guild)->>'is_public')::boolean, false) is not true then
    raise exception 'This Guild is not public';
  end if;

  insert into public.coolanas_guild_members (guild_id, user_id, added_by)
  values (v_guild.id, auth.uid(), auth.uid())
  on conflict (guild_id, user_id) do nothing;

  get diagnostics v_inserted = row_count;

  return jsonb_build_object(
    'guild_id', v_guild.id,
    'joined', v_inserted = 1
  );
end;
$$;

revoke all on function public.coolanas_guild_join_public(uuid) from public, anon;
grant execute on function public.coolanas_guild_join_public(uuid) to authenticated;
