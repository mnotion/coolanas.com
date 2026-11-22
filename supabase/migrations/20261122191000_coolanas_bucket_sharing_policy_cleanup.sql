-- Consolidate file-read policies and index new notification foreign keys.

drop policy "Recipients can read accepted shared bucket files" on public.coolanas_files;
drop policy "Users can read own Coolanas files" on public.coolanas_files;

create policy "Users can read own or accepted shared Coolanas files"
  on public.coolanas_files for select to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1
      from public.bucket_shares as share
      where share.owner_id = coolanas_files.owner_id
        and share.recipient_id = (select auth.uid())
        and share.revoked_at is null
        and coolanas_files.storage_path is not null
        and left(coolanas_files.storage_path, length(share.bucket_path)) = share.bucket_path
    )
  );

create index mail_notifications_bucket_id_idx
  on public.mail_notifications (bucket_id);
create index mail_notifications_invitation_id_idx
  on public.mail_notifications (invitation_id);
create index mail_notifications_sender_id_idx
  on public.mail_notifications (sender_id);

