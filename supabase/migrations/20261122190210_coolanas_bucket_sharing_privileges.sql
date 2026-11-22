-- Restrict client privileges to the minimum used by the Coolanas sharing UI.
revoke all on public.bucket_shares from public, anon, authenticated;
revoke all on public.bucket_share_invitations from public, anon, authenticated;
revoke all on public.mail_notifications from public, anon, authenticated;

grant select on public.bucket_shares to authenticated;
grant select on public.bucket_share_invitations to authenticated;
grant select on public.mail_notifications to authenticated;
grant update (read_at) on public.mail_notifications to authenticated;
