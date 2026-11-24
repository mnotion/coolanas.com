/* Account-scoped appearance bootstrap backed by server JSON state and mirrored to B2 settings.json. */
(() => {
  const root = document.documentElement;
  let mode = "light";
  let userId = null;
  let supabase = null;
  let ready = false;
  let activeAccessToken = null;
  let pendingThemeSave = null;
  let clientReadyResolve;
  const clientReady = new Promise(resolve => { clientReadyResolve = resolve; });
  const loads = new Map();
  const retryTimers = new Map();

  const apply = value => {
    mode = value === "dark" ? "dark" : "light";
    root.classList.toggle("dark-mode", mode === "dark");
    root.dataset.theme = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = mode === "dark" ? "#17191d" : "#ffffff";
    window.dispatchEvent(new CustomEvent("coolanas:themechange", {detail:{mode}}));
  };

  const save = async value => {
    if (!supabase || !userId) throw new Error("Your settings are not ready yet.");
    const {data, error} = await supabase.functions.invoke("coolanas-files-b2", {
      body: {action:"settings_update", settings:{theme:value}}
    });
    if (error || data?.error) throw new Error(data?.error || error?.message || "Could not save settings.");
  };

  const persistTheme = async value => {
    if (!userId || !supabase) return;
    pendingThemeSave = value;
    try { localStorage.setItem("coolanas-theme:" + userId, value); } catch {}
    try {
      await save(value);
      if (pendingThemeSave === value) pendingThemeSave = null;
    } catch (error) {
      console.error("Could not save appearance setting; it will retry:", error);
      setTimeout(() => {
        if (pendingThemeSave === value) void persistTheme(value);
      }, 5000);
    }
  };

  const set = value => {
    const next = value === "dark" ? "dark" : "light";
    apply(next);
    if (userId) void persistTheme(next);
  };

  async function flushThemeOnExit() {
    if (!pendingThemeSave || !userId || !activeAccessToken) return;
    const value = pendingThemeSave;
    try {
      await fetch("https://nacwftrsdpglzrhasmit.supabase.co/functions/v1/coolanas-files-b2", {
        method:"POST",
        keepalive:true,
        credentials:"omit",
        headers:{
          "Content-Type":"application/json",
          apikey:"sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF",
          Authorization:"Bearer " + activeAccessToken
        },
        body:JSON.stringify({action:"settings_update",settings:{theme:value}})
      });
    } catch (error) {
      console.warn("Final theme settings sync will retry on next sign-in:",error);
    }
  }
  window.addEventListener("pagehide", () => { void flushThemeOnExit(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void flushThemeOnExit();
  });

  apply("light");
  window.CoolanasTheme = {
    get: () => mode,
    set,
    apply,
    ready: () => ready
  };

  function scheduleSettingsRetry(targetUserId) {
    if (retryTimers.has(targetUserId)) clearTimeout(retryTimers.get(targetUserId));
    const timer = setTimeout(async () => {
      retryTimers.delete(targetUserId);
      if (userId !== targetUserId) return;
      try {
        const {data:{session},error} = await supabase.auth.getSession();
        if (error) throw error;
        if (session?.user?.id === targetUserId) await loadForSession(session);
      } catch (error) {
        console.warn("Account settings retry deferred:",error);
        scheduleSettingsRetry(targetUserId);
      }
    },60000);
    retryTimers.set(targetUserId,timer);
  }

  async function loadForSession(session) {
    if (!session?.user?.id) return {};
    await clientReady;
    activeAccessToken = session.access_token;
    const {error: sessionSetError} = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token
    });
    if (sessionSetError) throw sessionSetError;
    const nextUserId = session.user.id;
    if (userId !== nextUserId) {
      userId = nextUserId;
      ready = false;
    }
    if (loads.has(nextUserId)) return loads.get(nextUserId);

    const task = (async () => {
      let cachedMode = null;
      try {
        const cached = localStorage.getItem("coolanas-theme:" + nextUserId);
        if (cached === "dark" || cached === "light") cachedMode = cached;
      } catch {}
      if (cachedMode) apply(cachedMode);

      const {data, error} = await supabase.functions.invoke("coolanas-files-b2", {
        body: {action:"settings_get"}
      });
      if (error || data?.error) {
        throw new Error(data?.error || error?.message || "Could not load account settings.");
      }
      const settings = data?.settings && typeof data.settings === "object" ? data.settings : {};
      const cloudTheme = settings.theme === "dark" || settings.theme === "light"
        ? settings.theme : null;
      // Cloud JSON is authoritative. During a capped B2 import, do not write a
      // guessed light default: an older dark preference may still be in settings.json.
      const importPending = data?.legacyImportPending === true;
      const selectedTheme = cloudTheme || cachedMode || (importPending ? null : "light");
      if (selectedTheme) {
        apply(selectedTheme);
        try { localStorage.setItem("coolanas-theme:" + nextUserId, selectedTheme); } catch {}
        if (!cloudTheme && !importPending) await persistTheme(selectedTheme);
      }
      ready = true;
      if (!importPending) retryTimers.delete(nextUserId);
      window.dispatchEvent(new CustomEvent("coolanas:settingsready", {
        detail:{settings,userId:nextUserId,legacyImportPending:importPending,mirrorPending:data?.mirrorPending===true}
      }));
      if (importPending) scheduleSettingsRetry(nextUserId);
      return settings;
    })().catch(error => {
      console.error("Could not load account settings:", error);
      ready = true;
      window.dispatchEvent(new CustomEvent("coolanas:settingsready", {
        detail:{settings:{},userId:nextUserId,error}
      }));
      scheduleSettingsRetry(nextUserId);
      return {};
    }).finally(() => loads.delete(nextUserId));

    loads.set(nextUserId, task);
    return task;
  }

  window.CoolanasTheme = {
    get: () => mode,
    set,
    apply,
    ready: () => ready,
    loadForSession
  };

  (async () => {
    try {
      const {createClient} = await import("https://esm.sh/@supabase/supabase-js@2.119.0");
      supabase = createClient(
        "https://nacwftrsdpglzrhasmit.supabase.co",
        "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF",
        {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}}
      );
      clientReadyResolve();
      supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.access_token) activeAccessToken = session.access_token;
      });
      const {data:{session}, error} = await supabase.auth.getSession();
      if (error) throw error;
      if (session?.user) await loadForSession(session);
    } catch (error) {
      clientReadyResolve();
      console.error("Could not initialise account settings:", error);
    }
  })();
})();
