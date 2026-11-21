-- Keep move/reorder metadata updates inside a single Postgres transaction.
-- These functions run as the caller and enforce ownership through auth.uid().

create or replace function public.coolanas_reorder_files(
  p_ids uuid[],
  p_parent_id uuid default null
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  requested_count integer := coalesce(cardinality(p_ids), 0);
  matched_count integer;
begin
  if requested_count < 1 or requested_count > 200 then
    raise exception 'Invalid reorder list';
  end if;

  if p_parent_id is not null and not exists (
    select 1
    from public.coolanas_files parent
    where parent.id = p_parent_id
      and parent.owner_id = auth.uid()
      and parent.item_type = 'folder'
  ) then
    raise exception 'Destination folder not found or not owned by this account';
  end if;

  select count(*)
    into matched_count
  from public.coolanas_files item
  where item.id = any(p_ids)
    and item.owner_id = auth.uid()
    and item.parent_id is not distinct from p_parent_id;

  if matched_count <> requested_count then
    raise exception 'Items must belong to this account and the same folder';
  end if;

  update public.coolanas_files item
  set sort_order = ordered.ordinality * 10
  from unnest(p_ids) with ordinality as ordered(id, ordinality)
  where item.id = ordered.id
    and item.owner_id = auth.uid()
    and item.parent_id is not distinct from p_parent_id;
end;
$$;

create or replace function public.coolanas_move_files(p_changes jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  change_count integer;
  matched_count integer;
begin
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'Invalid move changes';
  end if;

  select count(*) into change_count
  from jsonb_array_elements(p_changes);

  if change_count < 1 or change_count > 1000 then
    raise exception 'Invalid move change count';
  end if;

  if (
    select count(distinct change.id)
    from jsonb_to_recordset(p_changes) as change(id uuid, parent_id uuid, storage_path text)
  ) <> change_count then
    raise exception 'Duplicate item in move changes';
  end if;

  select count(*) into matched_count
  from public.coolanas_files item
  join jsonb_to_recordset(p_changes) as change(id uuid, parent_id uuid, storage_path text)
    on change.id = item.id
  where item.owner_id = auth.uid();

  if matched_count <> change_count then
    raise exception 'One or more moved items are not owned by this account';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_changes) as change(id uuid, parent_id uuid, storage_path text)
    where change.parent_id is not null
      and not exists (
        select 1
        from public.coolanas_files parent
        where parent.id = change.parent_id
          and parent.owner_id = auth.uid()
          and parent.item_type = 'folder'
      )
  ) then
    raise exception 'A destination folder is not owned by this account';
  end if;

  if exists (
    with recursive folder_descendants(root_id, id) as (
      select item.id, item.id
      from public.coolanas_files item
      join jsonb_to_recordset(p_changes) as change(id uuid, parent_id uuid, storage_path text)
        on change.id = item.id
      where item.owner_id = auth.uid()
        and item.item_type = 'folder'
      union
      select descendants.root_id, child.id
      from folder_descendants descendants
      join public.coolanas_files child
        on child.parent_id = descendants.id
      where child.owner_id = auth.uid()
        and child.item_type = 'folder'
    )
    select 1
    from jsonb_to_recordset(p_changes) as change(id uuid, parent_id uuid, storage_path text)
    join folder_descendants descendants
      on descendants.root_id = change.id
     and descendants.id = change.parent_id
  ) then
    raise exception 'A folder cannot be moved inside itself or one of its descendants';
  end if;

  if exists (
    select 1
    from public.coolanas_files item
    join jsonb_to_recordset(p_changes) as change(id uuid, parent_id uuid, storage_path text)
      on change.id = item.id
    where item.owner_id = auth.uid()
      and (
        item.storage_path is null
        or change.storage_path is null
        or left(
          change.storage_path,
          length(split_part(item.storage_path, '/', 1) || '/' || split_part(item.storage_path, '/', 2) || '/')
        ) <> split_part(item.storage_path, '/', 1) || '/' || split_part(item.storage_path, '/', 2) || '/'
      )
  ) then
    raise exception 'A moved storage path must remain inside the current user folder';
  end if;

  update public.coolanas_files item
  set parent_id = change.parent_id,
      storage_path = change.storage_path
  from jsonb_to_recordset(p_changes) as change(id uuid, parent_id uuid, storage_path text)
  where item.id = change.id
    and item.owner_id = auth.uid();
end;
$$;

revoke all on function public.coolanas_reorder_files(uuid[], uuid) from public, anon;
revoke all on function public.coolanas_move_files(jsonb) from public, anon;
grant execute on function public.coolanas_reorder_files(uuid[], uuid) to authenticated;
grant execute on function public.coolanas_move_files(jsonb) to authenticated;
