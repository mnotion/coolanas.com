-- Keep shared paths current and let owners revoke shares after moving buckets.

-- Keep accepted share paths in sync when an owner moves a shared bucket.
create or replace function public.coolanas_sync_bucket_share_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.item_type = 'folder'
     and new.storage_path is not null
     and right(new.storage_path, 1) = '/'
     and old.storage_path is distinct from new.storage_path then
    update public.bucket_shares
      set bucket_path = new.storage_path
    where bucket_id = new.id
      and owner_id = new.owner_id
      and revoked_at is null;
  end if;
  return new;
end;
$function$;

revoke all on function public.coolanas_sync_bucket_share_path() from public, anon, authenticated;

drop trigger if exists coolanas_sync_bucket_share_path_trigger on public.coolanas_files;
create trigger coolanas_sync_bucket_share_path_trigger
  after update of storage_path on public.coolanas_files
  for each row
  when (old.storage_path is distinct from new.storage_path and new.item_type = 'folder')
  execute function public.coolanas_sync_bucket_share_path();

-- Owners must still be able to revoke a share after moving the bucket.
create or replace function public.coolanas_revoke_bucket_share(
  p_bucket_id uuid,
  p_recipient_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_bucket_name text;
  v_sender_username text;
begin
  if v_actor is null then
    raise exception 'Sign in is required.';
  end if;
  if p_bucket_id is null or p_recipient_id is null or p_recipient_id = v_actor then
    raise exception 'Invalid share.';
  end if;

  select bucket.name into v_bucket_name
  from public.coolanas_files as bucket
  where bucket.id = p_bucket_id
    and bucket.owner_id = v_actor
    and bucket.item_type = 'folder';

  if not found then
    raise exception 'Bucket not found or not owned by this account.';
  end if;

  update public.bucket_shares
    set revoked_at = coalesce(revoked_at, now())
  where bucket_id = p_bucket_id
    and owner_id = v_actor
    and recipient_id = p_recipient_id
    and revoked_at is null;

  update public.bucket_share_invitations
    set status = 'revoked', updated_at = now(), responded_at = now()
  where bucket_id = p_bucket_id
    and owner_id = v_actor
    and recipient_id = p_recipient_id
    and status in ('pending', 'accepted');

  select profile.username into v_sender_username
  from public.profiles as profile
  where profile.id = v_actor;

  update public.mail_notifications
    set title = 'Bucket access removed',
        message = coalesce(v_sender_username, 'The owner') || ' has revoked access to ' || v_bucket_name || '.',
        read_at = coalesce(read_at, now()),
        payload = payload || jsonb_build_object('invitation_status', 'revoked')
  where bucket_id = p_bucket_id
    and recipient_id = p_recipient_id
    and type = 'bucket_invitation';

  return true;
end;
$function$;

revoke all on function public.coolanas_revoke_bucket_share(uuid, uuid) from public, anon;
grant execute on function public.coolanas_revoke_bucket_share(uuid, uuid) to authenticated;

