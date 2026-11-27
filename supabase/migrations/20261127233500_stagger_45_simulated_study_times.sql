-- Spread the 45 Bazaar demo timers evenly across a 9h50m range.
-- Each user receives a distinct elapsed time; adjacent users are about 13m24.5s apart.
with ranked as (
  select id, row_number() over (order by username asc) as rn
  from public.coolanas_bazaar_simulated_timers
  where run_id = 'bazaar-sim-45-20261127'
)
update public.coolanas_bazaar_simulated_timers sim
set
  elapsed_ms = round(35400000 - ((ranked.rn - 1) * 35400000.0 / 44))::bigint,
  started_at = statement_timestamp()
from ranked
where sim.id = ranked.id;
