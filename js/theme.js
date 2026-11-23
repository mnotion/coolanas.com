/* Shared, account-scoped appearance bootstrap backed by each user's B2 settings.json. */
(() => {
  const root = document.documentElement;
  let mode = "light";
  let userId = null;
  let supabase = null;
  let ready = false;

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

  (async () => {
    try {
      const {createClient} = await import("https://esm.sh/@supabase/supabase-js@2.119.0");
      supabase = createClient(
        "https://nacwftrsdpglzrhasmit.supabase.co",
        "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF",
        {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}}
      );
      const {data:{session}, error:sessionError} = await supabase.auth.getSession();
      if (sessionError || !session?.user) return;
      userId = session.user.id;
      let cachedMode = null;
      try {
        const cached = localStorage.getItem("coolanas-theme:" + userId);
        if (cached === "dark" || cached === "light") cachedMode = cached;
      } catch {}

      // Apply the account-scoped local preference immediately. This also keeps
      // the UI consistent while the B2 settings endpoint is being deployed.
      if (cachedMode) apply(cachedMode);

      let settings = {};
      try {
        const {data, error} = await supabase.functions.invoke("coolanas-files-b2", {
          body:{action:"settings_get"}
        });
        if (error || data?.error) throw new Error(data?.error || error?.message || "Could not load settings.");
        settings = data?.settings && typeof data.settings === "object" ? data.settings : {};
        const stored = settings.theme;
        if (stored === "dark" || stored === "light") {
          apply(stored);
          try { localStorage.setItem("coolanas-theme:" + userId, stored); } catch {}
        }
      } catch (error) {
        // The previous deployed Edge Function may not yet expose settings_get.
        // Keep the user's local preference rather than silently reverting to light.
        console.warn("Cloud settings unavailable; using this account's local theme preference:", error);
        if (!cachedMode) apply("light");
      }
      ready = true;
      window.dispatchEvent(new CustomEvent("coolanas:settingsready", {detail:{settings}}));
      window.addEventListener("storage", event => {
        if (event.key === "coolanas-theme:" + userId && (event.newValue === "dark" || event.newValue === "light")) apply(event.newValue);
      });
    } catch (error) {
      console.error("Could not initialise account appearance:", error);
    }
  })();
})();
