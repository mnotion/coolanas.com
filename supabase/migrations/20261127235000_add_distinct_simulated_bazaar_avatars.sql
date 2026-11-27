update public.coolanas_bazaar_simulated_timers
set avatar_url = 'https://api.dicebear.com/9.x/adventurer/svg?seed=CoolanasTest' || lpad(regexp_replace(username,'[^0-9]','','g'),2,'0')
where run_id='bazaar-sim-45-20261127';
