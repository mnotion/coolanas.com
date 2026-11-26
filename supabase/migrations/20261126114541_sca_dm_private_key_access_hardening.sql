-- Private-key escrow is only available to authenticated account owners through RLS.
revoke all on table public.coolanas_dm_key_backups from public, anon;
grant select, insert, update, delete on table public.coolanas_dm_key_backups to authenticated;
