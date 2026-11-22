create or replace function public.coolanas_update_storage_prefix(p_old_prefix text, p_new_prefix text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_files integer := 0;
  changed_shares integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign-in required.';
  end if;
  if p_old_prefix is null or p_new_prefix is null
     or length(p_old_prefix) < 12 or length(p_new_prefix) < 12
     or p_old_prefix = p_new_prefix then
    raise exception 'Invalid storage prefix change.';
  end if;

  update public.coolanas_files
  set storage_path = p_new_prefix || substring(storage_path from length(p_old_prefix) + 1)
  where owner_id = auth.uid()
    and left(storage_path, length(p_old_prefix) + 1) = p_old_prefix || '/';
  get diagnostics changed_files = row_count;

  update public.bucket_shares
  set bucket_path = p_new_prefix || substring(bucket_path from length(p_old_prefix) + 1)
  where owner_id = auth.uid()
    and left(bucket_path, length(p_old_prefix) + 1) = p_old_prefix || '/';
  get diagnostics changed_shares = row_count;

  return jsonb_build_object('files_updated', changed_files, 'shares_updated', changed_shares);
end;
$$;

revoke all on function public.coolanas_update_storage_prefix(text, text) from public;
grant execute on function public.coolanas_update_storage_prefix(text, text) to authenticated;
