alter table public.coolanas_dm_messages
  add column if not exists read_at timestamptz;

-- Read receipts did not exist before this release. Treat legacy messages as
-- already seen so the new indicator only reports messages sent after rollout.
update public.coolanas_dm_messages
set read_at = created_at
where read_at is null;

-- Authenticated users may update only the read_at column, never message content.
revoke update on table public.coolanas_dm_messages from public, anon, authenticated;
grant update (read_at) on table public.coolanas_dm_messages to authenticated;

drop policy if exists coolanas_dm_messages_mark_read on public.coolanas_dm_messages;
create policy coolanas_dm_messages_mark_read
on public.coolanas_dm_messages
for update
to authenticated
using (
  read_at is null
  and sender_id <> (select auth.uid())
  and exists (
    select 1
    from public.coolanas_dm_conversations c
    where c.id = coolanas_dm_messages.conversation_id
      and ((c.user_a = (select auth.uid())) or (c.user_b = (select auth.uid())))
  )
)
with check (
  read_at is not null
  and read_at >= created_at
  and sender_id <> (select auth.uid())
  and exists (
    select 1
    from public.coolanas_dm_conversations c
    where c.id = coolanas_dm_messages.conversation_id
      and ((c.user_a = (select auth.uid())) or (c.user_b = (select auth.uid())))
  )
);
