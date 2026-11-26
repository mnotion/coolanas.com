-- Prevent older clients from erasing a private key already synced to the account.
create or replace function public.coolanas_dm_preserve_private_key()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and old.private_key is not null and new.private_key is null then
    new.private_key := old.private_key;
  end if;
  return new;
end;
$function$;

revoke all on function public.coolanas_dm_preserve_private_key() from public, anon, authenticated;
drop trigger if exists coolanas_dm_preserve_private_key on public.coolanas_dm_key_backups;
create trigger coolanas_dm_preserve_private_key
before update on public.coolanas_dm_key_backups
for each row execute function public.coolanas_dm_preserve_private_key();
