create table if not exists public.coolanas_dm_key_backups (
  user_id uuid primary key references auth.users(id) on delete cascade,
  backup jsonb not null check (jsonb_typeof(backup) = 'object'),
  key_version integer not null default 2 check (key_version = 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.coolanas_dm_key_backups enable row level security;
grant select, insert, update, delete on public.coolanas_dm_key_backups to authenticated;

drop policy if exists coolanas_dm_key_backups_select_own on public.coolanas_dm_key_backups;
create policy coolanas_dm_key_backups_select_own on public.coolanas_dm_key_backups for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists coolanas_dm_key_backups_insert_own on public.coolanas_dm_key_backups;
create policy coolanas_dm_key_backups_insert_own on public.coolanas_dm_key_backups for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists coolanas_dm_key_backups_update_own on public.coolanas_dm_key_backups;
create policy coolanas_dm_key_backups_update_own on public.coolanas_dm_key_backups for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists coolanas_dm_key_backups_delete_own on public.coolanas_dm_key_backups;
create policy coolanas_dm_key_backups_delete_own on public.coolanas_dm_key_backups for delete to authenticated using (user_id = (select auth.uid()));

create or replace function public.coolanas_dm_rotate_encryption_key(p_public_key jsonb, p_backup jsonb, p_updates jsonb)
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
begin
  if v_uid is null then raise exception 'Authentication required.'; end if;
  if jsonb_typeof(p_public_key) <> 'object' or p_public_key->>'kty' <> 'EC' or p_public_key->>'crv' <> 'P-256' then
    raise exception 'Invalid encryption public key.';
  end if;
  if jsonb_typeof(p_backup) <> 'object' or p_backup->>'v' <> '1' or p_backup->>'kdf' <> 'PBKDF2-SHA-256' then
    raise exception 'Invalid encrypted key backup.';
  end if;
  if jsonb_typeof(p_updates) <> 'array' then raise exception 'Invalid message update list.'; end if;

  v_total := jsonb_array_length(p_updates);
  select count(*) into v_distinct from (select distinct value->>'id' as id from jsonb_array_elements(p_updates)) items;
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
    where m.id is null or (c.user_a <> v_uid and c.user_b <> v_uid)
       or jsonb_typeof(x->'ciphertext') <> 'object' or x->'ciphertext'->>'v' <> '1'
  ) then raise exception 'Key rotation contains an invalid or inaccessible message.'; end if;

  for v_item in select value from jsonb_array_elements(p_updates)
  loop
    update public.coolanas_dm_messages set ciphertext = v_item->'ciphertext' where id = (v_item->>'id')::uuid;
  end loop;

  insert into public.coolanas_dm_keys(user_id, public_key, key_version, updated_at)
  values (v_uid, p_public_key, 2, now())
  on conflict (user_id) do update set public_key = excluded.public_key, key_version = 2, updated_at = now();

  insert into public.coolanas_dm_key_backups(user_id, backup, key_version, updated_at)
  values (v_uid, p_backup, 2, now())
  on conflict (user_id) do update set backup = excluded.backup, key_version = 2, updated_at = now();
end;
$function$;

revoke all on function public.coolanas_dm_rotate_encryption_key(jsonb, jsonb, jsonb) from public;
revoke all on function public.coolanas_dm_rotate_encryption_key(jsonb, jsonb, jsonb) from anon;
grant execute on function public.coolanas_dm_rotate_encryption_key(jsonb, jsonb, jsonb) to authenticated;
