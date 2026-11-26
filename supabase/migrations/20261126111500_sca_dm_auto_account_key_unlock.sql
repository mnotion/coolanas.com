-- Automatically provision each user's DM private key on the authenticated account.
-- This is account-managed key escrow: Coolanas operators/database administrators can access
-- the private key. Authenticated clients can read only their own row through existing RLS.

alter table public.coolanas_dm_key_backups
  add column if not exists private_key jsonb;

alter table public.coolanas_dm_key_backups
  alter column backup drop not null;

comment on column public.coolanas_dm_key_backups.private_key is
  'Account-managed ECDH private JWK. Readable only by the owning authenticated user through RLS; backend operators can access it.';

create or replace function public.coolanas_dm_rotate_encryption_key(
  p_public_key jsonb,
  p_backup jsonb,
  p_private_key jsonb,
  p_updates jsonb,
  p_expected_public_key jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_item jsonb;
  v_expected bigint;
  v_total integer;
  v_distinct integer;
  v_current_public_key jsonb;
begin
  if v_uid is null then raise exception 'Authentication required.'; end if;

  perform pg_advisory_xact_lock(hashtext(v_uid::text));
  select public_key into v_current_public_key
  from public.coolanas_dm_keys where user_id = v_uid for update;

  if p_expected_public_key is null then
    if found then raise exception 'An encryption key was registered by another device. Refresh and restore that key instead.'; end if;
  elsif not found or v_current_public_key is distinct from p_expected_public_key then
    raise exception 'The account encryption key changed on another device. Refresh and restore the latest key instead.';
  end if;

  if jsonb_typeof(p_public_key) <> 'object'
     or p_public_key->>'kty' <> 'EC'
     or p_public_key->>'crv' <> 'P-256'
     or coalesce(p_public_key->>'x','') = ''
     or coalesce(p_public_key->>'y','') = '' then
    raise exception 'Invalid encryption public key.';
  end if;

  if jsonb_typeof(p_private_key) <> 'object'
     or p_private_key->>'kty' <> 'EC'
     or p_private_key->>'crv' <> 'P-256'
     or coalesce(p_private_key->>'d','') = ''
     or coalesce(p_private_key->>'x','') = ''
     or coalesce(p_private_key->>'y','') = '' then
    raise exception 'Invalid account private key.';
  end if;

  if p_backup is not null and
     (jsonb_typeof(p_backup) <> 'object'
      or p_backup->>'v' <> '1'
      or p_backup->>'kdf' <> 'PBKDF2-SHA-256') then
    raise exception 'Invalid legacy encrypted key backup.';
  end if;
  if jsonb_typeof(p_updates) <> 'array' then raise exception 'Invalid message update list.'; end if;

  v_total := jsonb_array_length(p_updates);
  select count(*) into v_distinct
  from (select distinct value->>'id' as id from jsonb_array_elements(p_updates)) items;
  if v_total <> v_distinct then raise exception 'Duplicate message identifiers in key rotation.'; end if;

  select count(*) into v_expected
  from public.coolanas_dm_messages m
  join public.coolanas_dm_conversations c on c.id = m.conversation_id
  where c.user_a = v_uid or c.user_b = v_uid;
  if v_expected <> v_total then raise exception 'Conversation history changed during key rotation. Please retry.'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_updates) x
    left join public.coolanas_dm_messages m on m.id = (x->>'id')::uuid
    left join public.coolanas_dm_conversations c on c.id = m.conversation_id
    where m.id is null
       or (c.user_a <> v_uid and c.user_b <> v_uid)
       or jsonb_typeof(x->'ciphertext') <> 'object'
       or coalesce(x->'ciphertext'->>'v','') not in ('0','1')
  ) then
    raise exception 'Key rotation contains an invalid or inaccessible message.';
  end if;

  for v_item in select value from jsonb_array_elements(p_updates)
  loop
    update public.coolanas_dm_messages
      set ciphertext = v_item->'ciphertext'
      where id = (v_item->>'id')::uuid;
  end loop;

  insert into public.coolanas_dm_keys(user_id, public_key, key_version, updated_at)
  values (v_uid, p_public_key, 2, now())
  on conflict (user_id) do update
    set public_key = excluded.public_key,
        key_version = 2,
        updated_at = now();

  insert into public.coolanas_dm_key_backups(user_id, backup, private_key, key_version, updated_at)
  values (v_uid, p_backup, p_private_key, 2, now())
  on conflict (user_id) do update
    set backup = coalesce(excluded.backup, public.coolanas_dm_key_backups.backup),
        private_key = excluded.private_key,
        key_version = 2,
        updated_at = now();
end;
$function$;

revoke all on function public.coolanas_dm_rotate_encryption_key(jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.coolanas_dm_rotate_encryption_key(jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;
