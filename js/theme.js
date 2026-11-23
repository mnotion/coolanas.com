/* Shared, account-scoped appearance bootstrap backed by each user's B2 settings.json. */
(() => {
  const root = document.documentElement;
  let mode = "light";
  let userId = null;
  let supabase = null;
  let ready = false;
  let clientReadyResolve;
  const clientReady = new Promise(resolve => { clientReadyResolve = resolve; });
  const loads = new Map();

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

  const set = value => {
    const next = value === "dark" ? "dark" : "light";
    apply(next);
    if (userId) {
      try { localStorage.setItem("coolanas-theme:" + userId, next); } catch {}
      save(next).catch(error => {
        console.error("Could not save appearance setting:", error);
      });
    }
  };

  apply("light");
  window.CoolanasTheme = {
    get: () => mode,
    set,
    apply,
    ready: () => ready
  };

  async function loadForSession(session) {
    if (!session?.user?.id) return {};
    await clientReady;
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
      if (settings.theme === "dark" || settings.theme === "light") {
        apply(settings.theme);
        try { localStorage.setItem("coolanas-theme:" + nextUserId, settings.theme); } catch {}
      }
      ready = true;
      window.dispatchEvent(new CustomEvent("coolanas:settingsready", {detail:{settings, userId:nextUserId}}));
      return settings;
    })().catch(error => {
      console.error("Could not load account settings:", error);
      ready = true;
      window.dispatchEvent(new CustomEvent("coolanas:settingsready", {detail:{settings:{}, userId:nextUserId, error}}));
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
        "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQ",
        {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}}
      );
      clientReadyResolve();
      const {data:{session}, error} = await supabase.auth.getSession();
      if (error) throw error;
      if (session?.user) await loadForSession(session);
    } catch (error) {
      clientReadyResolve();
      console.error("Could not initialise account settings:", error);
    }
  })();
})();
