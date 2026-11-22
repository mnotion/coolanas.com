create or replace function public.coolanas_clear_mail_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign-in required.';
  end if;

  delete from public.mail_notifications
  where recipient_id = auth.uid();

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.coolanas_clear_mail_notifications() from public;
grant execute on function public.coolanas_clear_mail_notifications() to authenticated;
