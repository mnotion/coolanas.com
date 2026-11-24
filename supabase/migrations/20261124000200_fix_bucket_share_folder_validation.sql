-- Allow bucket sharing for any folder contained in the owner's Exhibitions tree.
-- The previous functions required the selected folder to be an immediate child of
-- the root folder. This rejected valid folders whose stored paths were nested.

create or replace function public.coolanas_create_bucket_invitation(
  p_bucket_id uuid,
  p_recipient_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_bucket_name text;
  v_bucket_color text;
  v_bucket_path text;
  v_sender_username text;
  v_invitation_id uuid;
begin
  if v_actor is null then
    raise exception 'Sign in is required.';
  end if;
  if p_bucket_id is null or p_recipient_id is null or p_recipient_id = v_actor then
    raise exception 'Choose another Coolanas user.';
  end if;

  select bucket.name, bucket.folder_color, bucket.storage_path
    into v_bucket_name, v_bucket_color, v_bucket_path
  from public.coolanas_files as bucket
  join public.coolanas_files as root
    on root.owner_id = v_actor
   and root.item_type = 'folder'
   and root.name = 'exhibitions'
   and root.parent_id is null
   and bucket.id <> root.id
   and left(bucket.storage_path, length(root.storage_path)) = root.storage_path
  where bucket.id = p_bucket_id
    and bucket.owner_id = v_actor
    and bucket.item_type = 'folder'
  for update of bucket;

  if not found or v_bucket_path is null or right(v_bucket_path, 1) <> '/' then
    raise exception 'Bucket not found or not owned by this account.';
  end if;

  if not exists (
    select 1 from public.profiles as recipient_profile
    where recipient_profile.id = p_recipient_id
      and recipient_profile.username is not null
  ) then
    raise exception 'Coolanas user not found.';
  end if;

  if exists (
    select 1 from public.bucket_shares as share
    where share.bucket_id = p_bucket_id
      and share.recipient_id = p_recipient_id
      and share.owner_id = v_actor
      and share.revoked_at is null
  ) then
    raise exception 'This bucket is already shared with that user.';
  end if;

  if exists (
    select 1 from public.bucket_share_invitations as invitation
    where invitation.bucket_id = p_bucket_id
      and invitation.recipient_id = p_recipient_id
      and invitation.owner_id = v_actor
      and invitation.status = 'pending'
  ) then
    raise exception 'An invitation is already pending for that user.';
  end if;

  insert into public.bucket_share_invitations (bucket_id, owner_id, recipient_id)
  values (p_bucket_id, v_actor, p_recipient_id)
  returning id into v_invitation_id;

  select profile.username into v_sender_username
  from public.profiles as profile
  where profile.id = v_actor;

  insert into public.mail_notifications (
    recipient_id, sender_id, type, title, message,
    bucket_id, invitation_id, payload
  ) values (
    p_recipient_id,
    v_actor,
    'bucket_invitation',
    'New bucket invitation',
    coalesce(v_sender_username, 'A Coolanas user') || ' has offered you their bucket.',
    p_bucket_id,
    v_invitation_id,
    jsonb_build_object(
      'bucket_name', v_bucket_name,
      'bucket_color', v_bucket_color,
      'sender_username', v_sender_username,
      'invitation_status', 'pending'
    )
  );

  return v_invitation_id;
end;
$function$;

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
      on root.owner_id = v_invitation.owner_id
     and root.item_type = 'folder'
     and root.name = 'exhibitions'
     and root.parent_id is null
     and bucket.id <> root.id
     and left(bucket.storage_path, length(root.storage_path)) = root.storage_path
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

revoke all on function public.coolanas_create_bucket_invitation(uuid, uuid) from public, anon;
revoke all on function public.coolanas_respond_bucket_invitation(uuid, text) from public, anon;
grant execute on function public.coolanas_create_bucket_invitation(uuid, uuid) to authenticated;
grant execute on function public.coolanas_respond_bucket_invitation(uuid, text) to authenticated;
