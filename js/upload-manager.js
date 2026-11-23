(() => {
  const DB_NAME = "coolanas-background-uploads", STORE = "tasks";
  const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
  const SUPABASE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
  let registration = null, dbPromise = null;
  const style = document.createElement("style");
  style.textContent = `
    #coolanas-upload-status{position:fixed;z-index:2147483000;top:12px;left:12px;bottom:auto;right:auto;transform:none;width:min(300px,calc(100vw - 24px));padding:9px 11px;background:var(--upload-bg,#fff);color:var(--upload-fg,#222);border:1px solid rgba(120,120,120,.2);border-radius:11px;box-shadow:0 4px 18px rgba(0,0,0,.13);font:12px/1.35 system-ui,-apple-system,sans-serif;display:none}
    #coolanas-upload-status.visible{display:block}
    #coolanas-upload-status .cu-top{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-weight:650}
    #coolanas-upload-status .cu-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #coolanas-upload-status .cu-track{height:4px;border-radius:8px;background:rgba(120,120,120,.2);overflow:hidden}
    #coolanas-upload-status .cu-fill{height:100%;width:0;background:#4778ee;transition:width .2s}
    #coolanas-upload-status .cu-bottom{display:flex;justify-content:space-between;gap:8px;margin-top:5px;opacity:.7;font-size:10px}
    #coolanas-upload-status button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:2px 3px}
    #coolanas-upload-status .cu-terminate{color:#c33;font-weight:650}
    @media(prefers-color-scheme:dark){#coolanas-upload-status{--upload-bg:#242424;--upload-fg:#f5f5f5}}
  `;
  document.head.append(style);
  const panel = document.createElement("section");
  panel.id = "coolanas-upload-status";
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML =
      "<div class=\"cu-top\"><span class=\"cu-title\">Uploading files</span><button type=\"button\" class=\"cu-dismiss\">Hide</button><button type=\"button\" class=\"cu-terminate\">Terminate</button></div><div class=\"cu-track\"><div class=\"cu-fill\"></div></div><div class=\"cu-bottom\"><span class=\"cu-detail\">Preparing…</span><span class=\"cu-count\"></span></div>";
  document.body.append(panel);
  panel.querySelector(".cu-dismiss")
      .addEventListener("click", () => panel.classList.remove("visible"));
  function currentUserId() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.endsWith("-auth-token")) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        const id = value?.user?.id || value?.currentSession?.user?.id;
        if (id) return id;
        const token = value?.access_token || value?.currentSession?.access_token;
        if (token) {
          const payload =
              JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          if (payload.sub) return payload.sub;
        }
      } catch {
      }
    }
    return null;
  }
  function openDb() {
    if (!("indexedDB" in window))
      return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
    if (!dbPromise)
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 3);
        req.onupgradeneeded = () => {
          const db = req.result;
          const store = db.objectStoreNames.contains(STORE) ?
              req.transaction.objectStore(STORE) :
              db.createObjectStore(STORE, {keyPath: "id"});
          if (!store.indexNames.contains("status")) store.createIndex("status", "status");
          if (!store.indexNames.contains("batchId")) store.createIndex("batchId", "batchId");
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => db.close();
          if (!db.objectStoreNames.contains(STORE)) {
            db.close();
            dbPromise = null;
            reject(new Error(
                "Upload storage schema repair did not create the tasks store. Reload the page and retry."));
            return;
          }
          resolve(db);
        };
        req.onerror = () => {
          dbPromise = null;
          reject(req.error || new Error("Could not open upload storage."));
        };
        req.onblocked = () =>
            console.warn("Waiting for another tab to release upload storage for upgrade.");
      });
    return dbPromise;
  }
  async function getTasks() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      } catch (error) {
        reject(error);
        return;
      }
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error("Could not read upload queue."));
    });
  }
  async function refresh() {
    const userId = currentUserId();
    if (!userId) {
      panel.classList.remove("visible");
      return;
    }
    const tasks = (await getTasks()).filter(t => t.ownerId === userId);
    window.dispatchEvent(new CustomEvent("coolanas-upload-updated", {detail: tasks}));
    const active = tasks.filter(t => t.status === "pending" || t.status === "uploading");
    const failed = tasks.filter(t => t.status === "failed");
    const completed = tasks.filter(t => t.status === "complete");
    const total = active.length + failed.length + completed.length;
    if (!total) {
      panel.classList.remove("visible");
      return;
    }
    if (!active.length && !failed.length) {
      panel.classList.remove("visible");
      return;
    }
    const done = completed.length, uploading = active.filter(t => t.status === "uploading").length;
    panel.classList.add("visible");
    panel.querySelector(".cu-title").textContent =
        failed.length ? "Uploads need attention" : "Uploading files";
    panel.querySelector(".cu-fill").style.width =
        (total ? Math.round(done / total * 100) : 0) + "%";
    panel.querySelector(".cu-detail").textContent =
        failed[0]?.error || active[0]?.fileName || "Finishing uploads…";
    panel.querySelector(".cu-count").textContent =
        done + "/" + total + " · " + uploading + " active";
    window.dispatchEvent(new CustomEvent("coolanas-upload-updated", {detail: tasks}));
  }
  async function registerWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      registration = await navigator.serviceWorker.register(
          "/upload-sw.js?v=3", {scope: "/", updateViaCache: "none"});
      await navigator.serviceWorker.ready;
      navigator.serviceWorker.addEventListener("message", event => {
        if (event.data?.type === "COOLANAS_UPLOADS_UPDATED") refresh();
      });
      return registration;
    } catch (error) {
      console.warn("Background uploads unavailable:", error);
      return null;
    }
  }
  async function enqueue(tasks, auth) {
    try {
      await navigator.storage?.persist?.();
    } catch {
    }
    const db = await openDb();
    if (!db) throw new Error("This browser cannot store background uploads.");
    const batchId = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite"), store = tx.objectStore(STORE);
      for (const task of tasks)
        store.put({
          id: crypto.randomUUID(),
          batchId,
          ownerId: auth.userId,
          file: task.file,
          fileName: task.fileName,
          parentId: task.parentId ?? null,
          contentType: task.file.type || "application/octet-stream",
          accessToken: auth.accessToken,
          status: "pending",
          createdAt: Date.now(),
          error: null
        });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await refresh();
    if (!registration) await registerWorker();
    if (registration?.sync) {
      try {
        await registration.sync.register("coolanas-upload-queue");
      } catch (error) {
        console.warn("Background Sync unavailable:", error);
      }
    }
    registration?.active?.postMessage({type: "PROCESS_COOLANAS_UPLOADS"});
    navigator.serviceWorker?.controller?.postMessage({type: "PROCESS_COOLANAS_UPLOADS"});
    return {batchId, count: tasks.length};
  }
  async function terminate() {
    const userId = currentUserId();
    if (!userId) return;
    const owned =
        (await getTasks())
            .filter(
                t => t.ownerId === userId && (t.status === "pending" || t.status === "uploading"));
    if (!owned.length) return;
    if (!confirm(
            "Terminate " + owned.length +
            " unfinished upload(s)? Files not yet completed will not be uploaded."))
      return;
    const db = await openDb();
    await new Promise(resolve => {
      const tx = db.transaction(STORE, "readwrite"), store = tx.objectStore(STORE);
      for (const task of owned)
        store.put({
          ...task,
          status: "cancelled",
          file: null,
          uploadUrl: null,
          error: "Terminated by you"
        });
      tx.oncomplete = tx.onerror = tx.onabort = resolve;
    });
    const message = {
      type: "TERMINATE_COOLANAS_UPLOADS",
      ownerId: userId,
      taskIds: owned.map(t => t.id)
    };
    registration?.active?.postMessage(message);
    navigator.serviceWorker?.controller?.postMessage(message);
    await refresh();
  }
  panel.querySelector(".cu-terminate").addEventListener("click", terminate);
  navigator.serviceWorker?.addEventListener("message", event => {
    if (event.data?.type === "COOLANAS_UPLOADS_UPDATED") refresh();
  });
  window.addEventListener("storage", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  window.CoolanasUploads = {enqueue, refresh, getTasks};
  registerWorker().then(async () => {
    await refresh();
    const userId = currentUserId();
    const pending = (await getTasks())
                        .some(
                            task => task.ownerId === userId &&
                                (task.status === "pending" || task.status === "uploading"));
    if (pending) registration?.active?.postMessage({type: "PROCESS_COOLANAS_UPLOADS"});
  });
  setInterval(refresh, 1000);
})();