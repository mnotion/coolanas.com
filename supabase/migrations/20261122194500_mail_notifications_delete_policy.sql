create policy "Users can delete their own mail notifications"
on public.mail_notifications
for delete
to authenticated
using ((select auth.uid()) = recipient_id);
