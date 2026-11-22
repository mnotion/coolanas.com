-- Add owner-controlled read-only permission levels and notification events for bucket shares.
alter table public.bucket_shares
  add column permission text not null default 'view_download'
  check (permission in ('view', 'view_download'));

create or replace function public.coolanas_respond_bucket_invitation(
  p_invitation_id uuid,
  p_response text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_invitation public.bucket_share_invitations%rowtype;
  v_bucket_path text;
  v_bucket_name text;
  v_actor_username text;
begin
  if v_actor is null then
    raise exception 'Sign in is required.';
  end if;
  if p_response not in ('accept', 'decline') then
    raise exception 'Choose accept or decline.';
  end if;

  select * into v_invitation
  from public.bucket_share_invitations as invitation
  where invitation.id = p_invitation_id
    and invitation.recipient_id = v_actor
    and invitation.status = 'pending'
  for update;

  if not found then
    raise exception 'This invitation is no longer available.';
  end if;

  if p_response = 'accept' then
    select bucket.storage_path, bucket.name
      into v_bucket_path, v_bucket_name
    from public.coolanas_files as bucket
    join public.coolanas_files as root
      on root.id = bucket.parent_id
     and root.owner_id = v_invitation.owner_id
     and root.item_type = 'folder'
     and root.name = 'exhibitions'
     and root.parent_id is null
    where bucket.id = v_invitation.bucket_id
      and bucket.owner_id = v_invitation.owner_id
      and bucket.item_type = 'folder';

    if v_bucket_path is null or right(v_bucket_path, 1) <> '/' then
      raise exception 'The owner has removed or moved this bucket.';
    end if;

    insert into public.bucket_shares
      (bucket_id, owner_id, recipient_id, bucket_path, permission, revoked_at)
    values
      (v_invitation.bucket_id, v_invitation.owner_id, v_actor, v_bucket_path, 'view_download', null)
    on conflict (bucket_id, recipient_id)
    do update set owner_id = excluded.owner_id,
                  bucket_path = excluded.bucket_path,
                  permission = 'view_download',
                  revoked_at = null,
                  created_at = now();

    update public.bucket_share_invitations
      set status = 'accepted', updated_at = now(), responded_at = now()
    where id = v_invitation.id;

    select profile.username into v_actor_username
    from public.profiles as profile
    where profile.id = v_actor;

    insert into public.mail_notifications (
      recipient_id, sender_id, type, title, message, bucket_id, invitation_id, payload
    ) values (
      v_invitation.owner_id,
      v_actor,
      'bucket_share_accepted',
      'Bucket invitation accepted',
      coalesce(v_actor_username, 'A Coolanas user') || ' has accepted your offer to share "' || v_bucket_name || '".',
      v_invitation.bucket_id,
      v_invitation.id,
      jsonb_build_object(
        'bucket_name', v_bucket_name,
        'recipient_username', v_actor_username,
        'invitation_status', 'accepted'
      )
    );
  else
    update public.bucket_share_invitations
      set status = 'declined', updated_at = now(), responded_at = now()
    where id = v_invitation.id;
  end if;

  update public.mail_notifications
    set read_at = coalesce(read_at, now()),
        payload = payload || jsonb_build_object('invitation_status', p_response)
    where invitation_id = v_invitation.id
      and recipient_id = v_actor;

  return p_response;
end;
$function$;

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
        and invitation.status in ('pending', 'accepted')
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

create or replace function public.coolanas_update_bucket_share_permission(
  p_bucket_id uuid,
  p_recipient_id uuid,
  p_permission text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Sign in is required.';
  end if;
  if p_permission not in ('view', 'view_download') then
    raise exception 'Choose a valid bucket permission.';
  end if;

  update public.bucket_shares
    set permission = p_permission
  where bucket_id = p_bucket_id
    and owner_id = v_actor
    and recipient_id = p_recipient_id
    and revoked_at is null;

  if not found then
    raise exception 'Active bucket sharing access was not found.';
  end if;

  return true;
end;
$function$;

revoke all on function public.coolanas_respond_bucket_invitation(uuid, text) from public, anon;
revoke all on function public.coolanas_revoke_bucket_share(uuid, uuid) from public, anon;
revoke all on function public.coolanas_update_bucket_share_permission(uuid, uuid, text) from public, anon;
grant execute on function public.coolanas_respond_bucket_invitation(uuid, text) to authenticated;
grant execute on function public.coolanas_revoke_bucket_share(uuid, uuid) to authenticated;
grant execute on function public.coolanas_update_bucket_share_permission(uuid, uuid, text) to authenticated;
