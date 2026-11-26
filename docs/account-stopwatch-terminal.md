# Account-owned stopwatch terminal

## Source of truth

`public.coolanas_account_stopwatches` contains one row per authenticated account. The primary key is `user_id`. Row Level Security only exposes the signed-in user's own row.

The Dashboard writes commands through `coolanas_account_stopwatch_action` with `p_action` set to `get`, `start`, `pause`, or `reset`. The RPC serialises commands with a row lock and returns the current state, database time, row version, and whether the requested command changed state.

## Guild reader

The Guild timer is read-only. With the same Supabase authenticated session, it should:

1. Call `coolanas_account_stopwatch_action({ p_action: "get" })` when it opens and after a Realtime reconnect.
2. Subscribe to `postgres_changes` on `public.coolanas_account_stopwatches`, filtered to `user_id=eq.<auth.uid()>`.
3. On a matching event, call the `get` RPC again so the client receives a fresh `server_now` value.
4. Display `elapsed_ms` plus the difference between corrected current time and `started_at` while running. When `started_at` is null, display `elapsed_ms` only.
5. Never query the retired `coolanas_guild_stopwatch` singleton or subscribe without the per-user filter.

The Guild must not add start, pause, or reset controls. The database RLS policy is the security boundary: it prevents one signed-in account from reading another account's row, regardless of the UI.

## Realtime client example

```js
const {data: {user}} = await supabase.auth.getUser();
const channel = supabase.channel("guild-stopwatch-" + user.id)
  .on("postgres_changes", {
    event: "*",
    schema: "public",
    table: "coolanas_account_stopwatches",
    filter: "user_id=eq." + user.id
  }, () => {
    void supabase.rpc("coolanas_account_stopwatch_action", {
      p_action: "get"
    }).then(({data, error}) => {
      if (error) console.error("Stopwatch refresh failed:", error);
      else renderGuildTimer(Array.isArray(data) ? data[0] : data);
    });
  })
  .subscribe();
```

The initial Guild load should call the same `get` RPC before subscribing, then call it again when the subscription reaches `SUBSCRIBED`.
