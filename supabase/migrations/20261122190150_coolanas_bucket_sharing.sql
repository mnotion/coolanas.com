-- Coolanas bucket sharing: permanent, owner-revocable, read-only for recipients.

create table public.bucket_shares (
  id uuid primary key default gen_random_uuid(),
  bucket_id uuid not null references public.coolanas_files(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  bucket_path text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint bucket_shares_distinct_users check (owner_id <> recipient_id),
  constraint bucket_shares_bucket_recipient_key unique (bucket_id, recipient_id),
  constraint bucket_shares_path_is_directory check (right(bucket_path, 1) = '/')
);

create index bucket_shares_recipient_active_idx
  on public.bucket_shares (recipient_id, created_at desc)
  where revoked_at is null;
create index bucket_shares_owner_active_idx
  on public.bucket_shares (owner_id, bucket_id)
  where revoked_at is null;

create table public.bucket_share_invitations (
  id uuid primary key default gen_random_uuid(),
  bucket_id uuid not null references public.coolanas_files(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint bucket_share_invitations_distinct_users check (owner_id <> recipient_id)
);

create unique index bucket_share_one_pending_invitation_idx
  on public.bucket_share_invitations (bucket_id, recipient_id)
  where status = 'pending';
create index bucket_share_invitations_owner_idx
  on public.bucket_share_invitations (owner_id, created_at desc);
create index bucket_share_invitations_recipient_idx
  on public.bucket_share_invitations (recipient_id, created_at desc);

create table public.mail_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  type text not null,
  title text not null,
  message text not null,
  bucket_id uuid references public.coolanas_files(id) on delete cascade,
  invitation_id uuid references public.bucket_share_invitations(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index mail_notifications_recipient_created_idx
  on public.mail_notifications (recipient_id, created_at desc);

alter table public.bucket_shares enable row level security;
alter table public.bucket_share_invitations enable row level security;
alter table public.mail_notifications enable row level security;

revoke all on public.bucket_shares from public, anon;
revoke all on public.bucket_share_invitations from public, anon;
revoke all on public.mail_notifications from public, anon;

grant select on public.bucket_shares to authenticated;
grant select on public.bucket_share_invitations to authenticated;
grant select on public.mail_notifications to authenticated;
grant update (read_at) on public.mail_notifications to authenticated;

create policy "Users can view bucket shares they own or receive"
  on public.bucket_shares for select to authenticated
  using (owner_id = (select auth.uid()) or recipient_id = (select auth.uid()));

create policy "Users can view bucket invitations they sent or received"
  on public.bucket_share_invitations for select to authenticated
  using (owner_id = (select auth.uid()) or recipient_id = (select auth.uid()));

create policy "Users can view their own mail notifications"
  on public.mail_notifications for select to authenticated
  using (recipient_id = (select auth.uid()));

create policy "Users can mark their own mail notifications read"
  on public.mail_notifications for update to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

create policy "Recipients can read accepted shared bucket files"
  on public.coolanas_files for select to authenticated
  using (
    exists (
      select 1
      from public.bucket_shares as share
      where share.owner_id = coolanas_files.owner_id
        and share.recipient_id = (select auth.uid())
        and share.revoked_at is null
        and coolanas_files.storage_path is not null
        and left(coolanas_files.storage_path, length(share.bucket_path)) = share.bucket_path
    )
  );

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
    on root.id = bucket.parent_id
   and root.owner_id = v_actor
   and root.item_type = 'folder'
   and root.name = 'exhibitions'
   and root.parent_id is null
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
    select bucket.storage_path into v_bucket_path
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

    insert into public.bucket_shares (bucket_id, owner_id, recipient_id, bucket_path, revoked_at)
    values (v_invitation.bucket_id, v_invitation.owner_id, v_actor, v_bucket_path, null)
    on conflict (bucket_id, recipient_id)
    do update set owner_id = excluded.owner_id,
                  bucket_path = excluded.bucket_path,
                  revoked_at = null,
                  created_at = now();

    update public.bucket_share_invitations
      set status = 'accepted', updated_at = now(), responded_at = now()
    where id = v_invitation.id;
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
begin
  if v_actor is null then
    raise exception 'Sign in is required.';
  end if;
  if p_bucket_id is null or p_recipient_id is null or p_recipient_id = v_actor then
    raise exception 'Invalid share.';
  end if;

  select bucket.name into v_bucket_name
  from public.coolanas_files as bucket
  join public.coolanas_files as root
    on root.id = bucket.parent_id
   and root.owner_id = v_actor
   and root.item_type = 'folder'
   and root.name = 'exhibitions'
   and root.parent_id is null
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

revoke all on function public.coolanas_create_bucket_invitation(uuid, uuid) from public, anon;
revoke all on function public.coolanas_respond_bucket_invitation(uuid, text) from public, anon;
revoke all on function public.coolanas_revoke_bucket_share(uuid, uuid) from public, anon;
grant execute on function public.coolanas_create_bucket_invitation(uuid, uuid) to authenticated;
grant execute on function public.coolanas_respond_bucket_invitation(uuid, text) to authenticated;
grant execute on function public.coolanas_revoke_bucket_share(uuid, uuid) to authenticated;
