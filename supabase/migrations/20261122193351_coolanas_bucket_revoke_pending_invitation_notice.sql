-- Do not send an access-revoked alert when an owner only cancels a pending invitation.
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
  v_invitation_id uuid;
  v_was_shared boolean := false;
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

  select
    exists (
      select 1 from public.bucket_shares as share
      where share.bucket_id = p_bucket_id
        and share.owner_id = v_actor
        and share.recipient_id = p_recipient_id
        and share.revoked_at is null
    )
    or exists (
      select 1 from public.bucket_share_invitations as invitation
      where invitation.bucket_id = p_bucket_id
        and invitation.owner_id = v_actor
        and invitation.recipient_id = p_recipient_id
        and invitation.status = 'accepted'
    )
  into v_was_shared;

  select invitation.id into v_invitation_id
  from public.bucket_share_invitations as invitation
  where invitation.bucket_id = p_bucket_id
    and invitation.owner_id = v_actor
    and invitation.recipient_id = p_recipient_id
    and invitation.status in ('pending', 'accepted')
  order by invitation.created_at desc
  limit 1;

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

  if v_invitation_id is not null then
    update public.mail_notifications
      set read_at = coalesce(read_at, now()),
          payload = payload || jsonb_build_object('invitation_status', 'revoked')
    where invitation_id = v_invitation_id
      and recipient_id = p_recipient_id
      and type = 'bucket_invitation';
  end if;

  if v_was_shared then
    insert into public.mail_notifications (
      recipient_id, sender_id, type, title, message, bucket_id, invitation_id, payload
    ) values (
      p_recipient_id,
      v_actor,
      'bucket_access_revoked',
      'Bucket access revoked',
      coalesce(v_sender_username, 'The owner') || ' has revoked your access to "' || v_bucket_name || '".',
      p_bucket_id,
      v_invitation_id,
      jsonb_build_object(
        'bucket_name', v_bucket_name,
        'sender_username', v_sender_username,
        'invitation_status', 'revoked'
      )
    );
  end if;

  return true;
end;
$function$;

revoke all on function public.coolanas_revoke_bucket_share(uuid, uuid) from public, anon;
grant execute on function public.coolanas_revoke_bucket_share(uuid, uuid) to authenticated;
