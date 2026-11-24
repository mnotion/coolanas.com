const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
const {createClient} = await import("https://esm.sh/@supabase/supabase-js@2.119.0");
const supabase = createClient(
    SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
    {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}});

const {data: {session}, error: sessionError} = await supabase.auth.getSession();
if (sessionError || !session) {
  location.replace("index.html");
  throw new Error("Sign-in required");
}
await window.CoolanasTheme?.loadForSession(session);
const user = session.user;
const filesFunction = "coolanas-files-b2";
const bucketSvg =
    "<svg class=\"folder-icon bucket-icon\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5.1 8.2C3.3 5.1 5.7 2.5 12 2.5s8.7 2.6 6.9 5.7\"/><path d=\"M3.2 8.2h17.6l-2 12.1c-4.4 1.6-9.2 1.6-13.6 0L3.2 8.2Z\"/><path d=\"M3.2 8.2c4.9 1.1 12.7 1.1 17.6 0\"/><path d=\"M6.1 17.5c3.8 1 8 1 11.8 0\"/></svg>";

const folderSvg =
    "<svg class=\"folder-icon\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3.5 6.5h6l2 2H20a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-16A1.5 1.5 0 0 1 2.5 18V8a1.5 1.5 0 0 1 1-1.5Z\"/></svg>";

const fileSvg =
    "<svg class=\"file-icon\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M6 3.8h8l4 4V20H6z\"/><path d=\"M14 3.8V8h4\"/></svg>";

const list = document.getElementById("files-list");
const toolbar = document.getElementById("files-toolbar");
const currentFolder = document.getElementById("current-folder");
const viewer = document.getElementById("file-viewer");
const viewerTitle = document.getElementById("viewer-title");
const viewerContent = document.getElementById("viewer-content");
const filesThemeToggle = document.getElementById("files-theme-toggle");
function applyFilesTheme(mode) {
  window.CoolanasTheme?.apply(mode);
  document.documentElement.classList.toggle("dark-mode", mode === "dark");
  document.documentElement.dataset.theme = mode;
  filesThemeToggle.textContent = mode === "dark" ? "Switch to light mode" : "Switch to dark mode";
}
applyFilesTheme(window.CoolanasTheme?.get() || "light");
window.addEventListener("coolanas:themechange", event => applyFilesTheme(event.detail?.mode || "light"));
filesThemeToggle.addEventListener("click", () => {
  const mode = document.documentElement.classList.contains("dark-mode") ? "light" : "dark";
  window.CoolanasTheme?.set(mode);
  applyFilesTheme(mode);
});
window.addEventListener("storage", event => {
  if (event.key === "coolanas-theme") {
    applyFilesTheme(event.newValue === "dark" ? "dark" : "light");
    const accountToggle = document.getElementById("theme-toggle");
    if (accountToggle) accountToggle.textContent = event.newValue === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }
});
const uploadOverlay = document.getElementById("upload-overlay");
const uploadTitle = document.getElementById("upload-title");
const uploadDetail = document.getElementById("upload-detail");
const uploadProgress = document.getElementById("upload-progress-bar");
const uploadMini = document.getElementById("upload-mini");
const uploadMiniBar = document.getElementById("upload-mini-bar");
const uploadMiniPercent = document.getElementById("upload-mini-percent");
let activeUploadController = null, uploadMinimised = false, uploadCancelled = false;
document.getElementById("upload-minimise").addEventListener("click", () => {
  uploadMinimised = true;
  uploadOverlay.hidden = true;
  uploadMini.hidden = false;
});

document.getElementById("upload-cancel").addEventListener("click", () => {
  if (activeUploadController) {
    uploadCancelled = true;
    activeUploadController.abort();
  }
});
uploadMini.addEventListener("click", () => {
  uploadMinimised = false;
  uploadMini.hidden = true;
  uploadOverlay.hidden = false;
});
const dropHint = document.getElementById("drop-hint");
const marquee = document.getElementById("selection-marquee");
let items = [], ownedItems = [], currentFolderId = null, searchQuery = "", lastItemsLoad = 0;
let exhibitionRootId = null, exhibitionRecords = [], exhibitionTotalBytes = 0;
const workspaceCacheKey = "coolanas-bucket-cache:v2:" + user.id;
const workspaceCacheMaxAge = 10 * 60 * 1000;
let workspaceCacheTimestamp = 0;
let metadataCacheTimestamp = 0;
let renderedSharedBucketsSignature = "";
let sharedFolderCache = {};
function readWorkspaceCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(workspaceCacheKey) || "null");
    if (!cached || cached.userId !== user.id || !Array.isArray(cached.items)) return null;
    return cached;
  } catch {
    return null;
  }
}
function writeWorkspaceCache() {
  try {
    localStorage.setItem(workspaceCacheKey, JSON.stringify({
      userId: user.id,
      savedAt: workspaceCacheTimestamp || Date.now(),
      metadataSavedAt: metadataCacheTimestamp,
      rootId: exhibitionRootId,
      items: ownedItems,
      exhibitions: exhibitionRecords,
      totalBytes: exhibitionTotalBytes,
      sharedBuckets: sharedBucketRecords,
      sharedByYou: sharedByYouRecords,
      sharedFolderCache
    }));
  } catch (error) {
    console.warn("Could not cache bucket contents:", error.message);
  }
}
let activeSharedBucket = null, sharedBucketRecords = [], sharedByYouRecords = [], currentShareBucket = null;
const selectedIds = new Set();
let activeSettingsItem = null;
let pendingDeleteIds = [];
let internalDragIds = [];
let externalDragDepth = 0;
let objectUrl = null;
const main = document.querySelector("main");
const DOUBLE_TAP_WINDOW = 450;
const DOUBLE_TAP_DISTANCE = 36;
const GESTURE_MOVE_THRESHOLD = 7;
let previousPointerTap = null;
let pointerTapCandidate = null;
let activePointerMarquee = null;
let previousTouchTap = null;
let touchTapCandidate = null;
let activeTouchMarqueeId = null;
let marqueeStart = null;
// Authenticated requests to the Coolanas backend.
async function filesAction(action, payload = {}) {
  const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const {data, error} =
          await supabase.functions.invoke(filesFunction, {body: {action, ...payload}});
      if (error) {
        let detail = "";
        let status = Number(error.context?.status) || 0;
        try {
          if (error.context && typeof error.context.clone === "function") {
            const response = await error.context.clone();
            status = status || response.status;
            const body = await response.json();
            detail = body.error || body.message || "";
          }
        } catch {
        }
        const message = detail || error.message || "Files request failed.";
        if (attempt < maxAttempts &&
            (retryableStatuses.has(status) ||
             (!status && /network|fetch failed|temporar|unavailable/i.test(message)))) {
          await new Promise(
              resolve => setTimeout(resolve, Math.min(900 * 2 ** (attempt - 1), 12000)));
          continue;
        }
        throw new Error(message);
      }
      if (data?.error) throw new Error(data.error);
      return data;
    } catch (error) {
      if (attempt < maxAttempts && error instanceof TypeError) {
        await new Promise(
            resolve => setTimeout(resolve, Math.min(900 * 2 ** (attempt - 1), 12000)));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Files service is temporarily unavailable. Please retry.");
}
// Mail notifications and bucket invitations.
const mailButton = document.getElementById("mail-button"),
      mailPopover = document.getElementById("mail-popover"),
      mailNotifications = document.getElementById("mail-notifications");

const mailClearButton = document.getElementById("mail-clear-button");
const mailUnreadIndicator = document.getElementById("mail-unread-indicator");
function setMailUnreadIndicator(hasUnread) {
  mailUnreadIndicator.classList.toggle("visible", hasUnread);
  mailButton.setAttribute(
      "aria-label", hasUnread ? "Open mail (unread notifications)" : "Open mail");
}
async function refreshMail(markVisibleAsRead = false) {
  try {
    const {data, error} =
        await supabase.functions.invoke("coolanas-files-b2", {body: {action: "mail_list"}});
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    const notifications = data?.notifications || [];
    setMailUnreadIndicator(notifications.some(notification => !notification.read_at));
    mailNotifications.replaceChildren();
    if (!notifications.length) {
      const empty = document.createElement("p");
      empty.className = "mail-empty";
      empty.textContent = "No new mails.";
      mailNotifications.append(empty);
      return;
    }
    const markReadRequests = [];
    for (const notification of notifications) {
      const card = document.createElement("article");
      card.className = "mail-notification" + (notification.read_at ? "" : " unread");
      const title = document.createElement("h3");
      title.textContent = notification.title || "Coolanas notification";
      const message = document.createElement("p");
      message.textContent = notification.message || "";
      card.append(title, message);
      const status = notification.payload?.invitation_status;
      if (notification.type === "bucket_invitation" && status === "pending" &&
          notification.invitation_id) {
        const actions = document.createElement("div");
        actions.className = "mail-notification-actions";
        const accept = document.createElement("button");
        accept.type = "button";
        accept.textContent = "Accept";
        const decline = document.createElement("button");
        decline.type = "button";
        decline.className = "secondary";
        decline.textContent = "Decline";
        const respond = async (response) => {
          accept.disabled = true;
          decline.disabled = true;
          try {
            const {data: result, error: responseError} =
                await supabase.functions.invoke("coolanas-files-b2", {
                  body: {
                    action: "bucket_invitation_respond",
                    invitationId: notification.invitation_id,
                    response
                  }
                });

            if (responseError) throw responseError;
            if (result?.error) throw new Error(result.error);
            await refreshMail();
            if (typeof refreshSharedBuckets === "function") await refreshSharedBuckets();
          } catch (error) {
            const feedback = document.createElement("span");
            feedback.className = "mail-notification-status";
            feedback.textContent = error.message || "Could not update this invitation.";
            card.append(feedback);
            accept.disabled = false;
            decline.disabled = false;
          }
        };
        accept.addEventListener("click", () => respond("accept"));
        decline.addEventListener("click", () => respond("decline"));
        actions.append(accept, decline);
        card.append(actions);
      } else if (notification.type === "bucket_invitation" && status) {
        const label = document.createElement("span");
        label.className = "mail-notification-status";
        label.textContent = (status === "accepted" || status === "accept") ? "Invitation accepted" :
            (status === "declined" || status === "decline")                ? "Invitation declined" :
            status === "revoked"                                           ? "Access withdrawn" :
                                                                             "";

        card.append(label);
      }
      if (markVisibleAsRead && !notification.read_at) {
        markReadRequests.push(supabase.functions.invoke(
            "coolanas-files-b2",
            {body: {action: "mail_mark_read", notificationId: notification.id}}));
      }
      mailNotifications.append(card);
    }
    if (markReadRequests.length) {
      await Promise.allSettled(markReadRequests);
      await refreshMail(false);
    }
  } catch (error) {
    mailNotifications.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "mail-empty";
    empty.textContent = error.message || "Could not load mail.";
    mailNotifications.append(empty);
  }
}
mailClearButton.addEventListener("click", async () => {
  if (!window.confirm("Clear all mail notifications? This cannot be undone.")) return;
  mailClearButton.disabled = true;
  try {
    await filesAction("mail_clear");
    await refreshMail(false);
  } catch (error) {
    const feedback = document.createElement("p");
    feedback.className = "mail-empty";
    feedback.textContent = error.message || "Could not clear mail.";
    mailNotifications.prepend(feedback);
  } finally {
    mailClearButton.disabled = false;
  }
});
mailButton.addEventListener("click", () => {
  const opening = mailPopover.hidden;
  mailPopover.hidden = !opening;
  mailButton.setAttribute("aria-expanded", String(opening));
  if (opening) refreshMail(true);
});
refreshMail();
window.setInterval(() => refreshMail(false), 30000);
document.addEventListener("click", event => {
  if (!mailPopover.hidden && !mailPopover.contains(event.target) &&
      !mailButton.contains(event.target)) {
    mailPopover.hidden = true;
    mailButton.setAttribute("aria-expanded", "false");
  }
});
// Account menu, profile picture, and theme.
const profileButton = document.getElementById("profile-button"),
      profileDrawer = document.getElementById("profile-drawer"),
      profileBackdrop = document.getElementById("profile-backdrop");

const profileAvatar = document.getElementById("profile-avatar"),
      drawerAvatar = document.getElementById("drawer-avatar"),
      avatarFallback = document.getElementById("profile-avatar-fallback"),
      drawerAvatarFallback = document.getElementById("drawer-avatar-fallback");

const removePfpButton = document.getElementById("remove-pfp"),
      themeToggle = document.getElementById("theme-toggle"),
      profilePictureInput = document.getElementById("profile-picture-input");

const displayName =
    user.user_metadata?.full_name || user.user_metadata?.name || user.email || "Account";
document.getElementById("profile-name").textContent = displayName;
document.getElementById("profile-email").textContent = user.email || "";
let googleAvatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture || "",
    customProfilePicture = false;
function applyTheme(mode) {
  window.CoolanasTheme?.set(mode);
  document.documentElement.classList.toggle("dark-mode", mode === "dark");
  document.documentElement.dataset.theme = mode;
  themeToggle.textContent = mode === "dark" ? "Switch to light mode" : "Switch to dark mode";
}
applyTheme(window.CoolanasTheme?.get() || "light");
themeToggle.addEventListener(
    "click",
    () => applyTheme(document.documentElement.classList.contains("dark-mode") ? "light" : "dark"));
function setAvatar(url) {
  for (const img of [profileAvatar, drawerAvatar]) {
    img.onerror = null;
    if (url) {
      img.src = url;
      img.hidden = false;
      img.onerror = () => {
        img.onerror = null;
        if (customProfilePicture && googleAvatarUrl && url !== googleAvatarUrl) {
          customProfilePicture = false;
          setAvatar(googleAvatarUrl);
        } else
          img.hidden = true;
      };
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
  }
  avatarFallback.hidden = Boolean(url);
  drawerAvatarFallback.hidden = Boolean(url);
  avatarFallback.textContent = displayName.trim().charAt(0).toUpperCase() || "?";
  drawerAvatarFallback.textContent = avatarFallback.textContent;
  removePfpButton.hidden = !customProfilePicture;
}
async function profileAction(action, payload = {}) {
  const {data, error} =
      await supabase.functions.invoke(filesFunction, {body: {action, ...payload}});
  if (error) throw new Error(error.message || "Profile picture request failed.");
  if (data?.error) throw new Error(data.error);
  return data;
}
async function refreshProfilePicture() {
  const result = await profileAction("profile_picture_get");
  customProfilePicture = Boolean(result.exists && result.url);
  setAvatar(customProfilePicture ? result.url : googleAvatarUrl);
}
function closeProfileDrawer() {
  profileDrawer.classList.remove("open");
  profileDrawer.setAttribute("aria-hidden", "true");
  profileButton.setAttribute("aria-expanded", "false");
  profileBackdrop.hidden = true;
}
function openProfileDrawer() {
  profileDrawer.classList.add("open");
  profileDrawer.setAttribute("aria-hidden", "false");
  profileButton.setAttribute("aria-expanded", "true");
  profileBackdrop.hidden = false;
}
profileButton.addEventListener("click", openProfileDrawer);
document.getElementById("profile-close").addEventListener("click", closeProfileDrawer);
profileBackdrop.addEventListener("click", closeProfileDrawer);
document.getElementById("change-pfp").addEventListener("click", () => profilePictureInput.click());
profilePictureInput.addEventListener("change", async () => {
  const file = profilePictureInput.files?.[0];
  profilePictureInput.value = "";
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("Choose an image smaller than 20 MB.");
    const isGif = file.type === "image/gif" || /\.gif$/i.test(file.name),
          contentType = isGif ? "image/gif" : "image/png";
    let uploadBody = file;
    if (!isGif && file.type !== "image/png") {
      const bitmap = await createImageBitmap(file, {imageOrientation: "from-image"});
      try {
        const side = Math.min(bitmap.width, bitmap.height),
              canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(
            bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 512,
            512);
        uploadBody = await new Promise(
            (resolve, reject) => canvas.toBlob(
                blob => blob ? resolve(blob) : reject(new Error("Could not convert image.")),
                "image/png"));

      } finally {
        bitmap.close?.();
      }
    }
    const signed = await profileAction("profile_picture_upload", {contentType});
    const response = await fetch(
        signed.uploadUrl,
        {method: "PUT", headers: {"Content-Type": contentType}, body: uploadBody});
    if (!response.ok) throw new Error("Image upload failed.");
    await refreshProfilePicture();
    closeProfileDrawer();
  } catch (error) {
    alert(error.message || "Could not update profile picture.");
  }
});
removePfpButton.addEventListener("click", async () => {
  try {
    await profileAction("profile_picture_delete");
    customProfilePicture = false;
    setAvatar(googleAvatarUrl);
    closeProfileDrawer();
  } catch (error) {
    alert(error.message || "Could not remove profile picture.");
  }
});
async function leaveAccount() {
  const {error} = await supabase.auth.signOut({scope: "local"});
  if (error) throw error;
  location.assign("/index.html");
}
document.getElementById("profile-settings")
    .addEventListener("click", () => location.assign("/settings.html"));
document.getElementById("profile-signout")
    .addEventListener("click", () => leaveAccount().catch(error => alert(error.message)));
document.getElementById("change-account")
    .addEventListener("click", () => leaveAccount().catch(error => alert(error.message)));
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeProfileDrawer();
});
setAvatar(googleAvatarUrl);
refreshProfilePicture().catch(
    error => console.warn("Could not load profile picture:", error.message));
// Offline queue for file and folder changes.
const pendingMutationDb = new Promise((resolve, reject) => {
  const request = indexedDB.open("coolanas-files-sync", 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("mutations"))
      db.createObjectStore("mutations", {keyPath: "id"});
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () =>
      reject(request.error || new Error("Could not open the pending sync queue."));
});
async function pendingMutationTransaction(mode, work) {
  const db = await pendingMutationDb;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("mutations", mode);
    const store = transaction.objectStore("mutations");
    let result;
    try {
      result = work(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () =>
        reject(transaction.error || new Error("Pending sync storage failed."));
    transaction.onabort = () =>
        reject(transaction.error || new Error("Pending sync transaction was aborted."));
  });
}
async function savePendingMutation(mutation) {
  const db = await pendingMutationDb;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("mutations", "readwrite");
    const store = transaction.objectStore("mutations");
    const request = store.getAll();
    request.onsuccess = () => {
      const existing =
          (request.result || [])
              .filter(
                  entry => entry.userId === mutation.userId && entry.itemId === mutation.itemId);
      if (mutation.type === "move") {
        const deletedIds = new Set(
            (request.result || [])
                .filter(entry => entry.userId === mutation.userId && entry.type === "delete")
                .map(entry => entry.itemId));
        mutation.changes.ids = (mutation.changes.ids || []).filter(id => !deletedIds.has(id));
        if (mutation.changes.ids.length) store.put(mutation);
        return;
      }
      if (mutation.type === "delete") {
        for (const entry of request.result || []) {
          if (entry.userId !== mutation.userId || entry.type !== "move" ||
              !entry.changes?.ids?.includes(mutation.itemId))
            continue;
          entry.changes.ids = entry.changes.ids.filter(id => id !== mutation.itemId);
          if (entry.changes.ids.length)
            store.put(entry);
          else
            store.delete(entry.id);
        }
        existing.forEach(entry => store.delete(entry.id));
        store.put(mutation);
        return;
      }
      if (existing.some(entry => entry.type === "delete")) return;
      const metadata = existing.filter(entry => entry.type === "metadata");
      if (metadata.length) {
        const base = metadata[0];
        const merged = {...base, changes: {...(base.changes || {}), ...(mutation.changes || {})}};
        metadata.slice(1).forEach(entry => store.delete(entry.id));
        store.put(merged);
      } else
        store.put(mutation);
    };
    request.onerror = () =>
        reject(request.error || new Error("Could not read queued file changes."));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
        reject(transaction.error || new Error("Could not save pending file changes."));
    transaction.onabort = () =>
        reject(transaction.error || new Error("Pending file change was not saved."));
  });
}
async function readPendingMutations() {
  const db = await pendingMutationDb;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("mutations", "readonly");
    const request = transaction.objectStore("mutations").getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("Could not read pending changes."));
  });
}
async function removePendingMutations(ids) {
  await pendingMutationTransaction("readwrite", store => ids.forEach(id => store.delete(id)));
}
let pendingFlushPromise = null;
let batchSyncSupported = true;
async function applyPendingToCache() {
  let pending = [];
  try {
    pending = (await readPendingMutations())
                  .filter(entry => entry.userId === user.id)
                  .sort((a, b) => a.createdAt - b.createdAt);
  } catch (error) {
    console.warn("Could not restore pending file changes:", error.message);
    return;
  }
  for (const entry of pending) {
    if (entry.type === "delete")
      removeCachedItems([entry.itemId]);
    else if (entry.type === "metadata") {
      const item = items.find(value => value.id === entry.itemId);
      if (item) Object.assign(item, entry.changes);
    } else if (entry.type === "move") {
      for (const id of entry.changes?.ids || []) {
        const item = items.find(value => value.id === id);
        if (item) {
          item.parent_id = entry.changes.targetParentId ?? null;
          item.sort_order = Number(entry.changes.sortOrders?.[id]) || item.sort_order || 0;
        }
      }
    }
  }
}
async function queueFileMutation(type, itemId, changes) {
  const mutation = {
    id: crypto.randomUUID(),
    userId: user.id,
    type,
    itemId,
    changes: changes || {},
    createdAt: Date.now()
  };
  try {
    await savePendingMutation(mutation);
  } catch (error) {
    if (type === "delete") {
      await filesAction("delete", {id: itemId});
      removeCachedItems([itemId]);
    } else {
      const result = await filesAction("update_metadata", {id: itemId, ...(changes || {})});
      upsertItem(result.item);
    }
    renderItems();
    return;
  }
  if (type === "delete")
    removeCachedItems([itemId]);
  else {
    const item = items.find(value => value.id === itemId);
    if (item) Object.assign(item, changes || {});
  }
  renderItems();
}
async function flushPendingMutations() {
  if (pendingFlushPromise) return pendingFlushPromise;
  pendingFlushPromise =
      (async () => {
        const pending = (await readPendingMutations())
                            .filter(entry => entry.userId === user.id)
                            .sort((a, b) => a.createdAt - b.createdAt)
                            .slice(0, 100);

        if (!pending.length) return;
        const queuedMoves = pending.filter(entry => entry.type === "move");
        const queuedMetadataAndDeletes = pending.filter(entry => entry.type !== "move");
        let updatedItems = [];
        if (queuedMetadataAndDeletes.length && batchSyncSupported) {
          try {
            const response = await filesAction("batch", {
              operations: queuedMetadataAndDeletes.map(
                  entry => ({type: entry.type, id: entry.itemId, changes: entry.changes}))
            });

            updatedItems = response.updatedItems || [];
            await removePendingMutations(queuedMetadataAndDeletes.map(entry => entry.id));
          } catch (batchError) {
            if (batchError.message !== "Unknown action.") throw batchError;
            batchSyncSupported = false;
          }
        }
        if (queuedMetadataAndDeletes.length && !batchSyncSupported) {
          for (const entry of queuedMetadataAndDeletes) {
            try {
              if (entry.type === "delete")
                await filesAction("delete", {id: entry.itemId});
              else {
                const response = await filesAction(
                    "update_metadata", {id: entry.itemId, ...(entry.changes || {})});
                if (response.item) updatedItems.push(response.item);
              }
            } catch (legacyError) {
              if (!/Item not found|File not found/i.test(legacyError.message)) throw legacyError;
            }
            await removePendingMutations([entry.id]);
          }
        }
        // Moves use the same five-second/exit queue, but need the storage-copy API
        // rather than the metadata-only batch endpoint.
        for (const entry of queuedMoves) {
          const ids = Array.isArray(entry.changes?.ids) ? entry.changes.ids : [];
          if (ids.length)
            await filesAction("move", {ids, targetParentId: entry.changes.targetParentId ?? null});
          await removePendingMutations([entry.id]);
        }
        for (const item of updatedItems) upsertItem(item);
        for (const entry of queuedMetadataAndDeletes)
          if (entry.type === "delete") removeCachedItems([entry.itemId]);
        // Do not rebuild a shared folder's DOM during the background sync.
        // Its contents are read-only here and should remain stable while open.
        if (!activeSharedBucket) renderItems();
        if (exhibitionRootId)
          refreshExhibitions().catch(
              error => console.warn("Storage usage refresh failed:", error.message));
      })()
          .catch(error => {
            console.warn("File changes remain queued until the next sync:", error.message);
          })
          .finally(() => {
            pendingFlushPromise = null;
          });
  return pendingFlushPromise;
}
setInterval(() => {
  flushPendingMutations();
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingMutations();
});
window.addEventListener("pagehide", () => {
  flushPendingMutations();
});
// Workspace navigation and file-card settings.
const searchPanel = document.getElementById("search-panel");
const menuPanel = document.getElementById("menu-panel");
const searchToggle = document.getElementById("search-toggle");
const menuToggle = document.getElementById("menu-toggle");
const settingsOverlay = document.getElementById("card-settings-overlay");
const tagInput = document.getElementById("card-tag-input");
const colorSection = document.getElementById("folder-color-section");
const tagSection = document.getElementById("tag-section");
function closeNavPanels() {
  searchPanel.hidden = true;
  menuPanel.hidden = true;
  searchToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-expanded", "false");
}
function toggleNavPanel(panel, toggle) {
  const shouldOpen = panel.hidden;
  closeNavPanels();
  if (shouldOpen) {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
  }
}
if (searchToggle?.tagName === "BUTTON")
  searchToggle.addEventListener("click", () => toggleNavPanel(searchPanel, searchToggle));
if (menuToggle) menuToggle.addEventListener("click", () => toggleNavPanel(menuPanel, menuToggle));
document.querySelectorAll(".panel [data-close]")
    .forEach(button => button.addEventListener("click", closeNavPanels));
document.getElementById("menu-home")
    .addEventListener("click", () => location.assign("/dashboard.html"));
document.getElementById("signout").addEventListener("click", async () => {
  const button = document.getElementById("signout");
  button.disabled = true;
  button.textContent = "Signing out…";
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      await flushPendingMutations();
      const remaining = (await readPendingMutations()).filter(entry => entry.userId === user.id);
      if (!remaining.length) break;
      if (attempt === 9)
        throw new Error(
            "Some changes have not been saved yet. Stay signed in and retry before signing out.");
    }
    const remaining = (await readPendingMutations()).some(entry => entry.userId === user.id);
    if (remaining)
      throw new Error(
          "Some changes have not been saved yet. Stay signed in and retry before signing out.");
    const {error} = await supabase.auth.signOut({scope: "local"});
    if (error) throw error;
    location.replace("index.html");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Sign out";
    alert("Could not sign out: " + (error.message || "Unknown error"));
  }
});
function closeCardSettings() {
  settingsOverlay.hidden = true;
  activeSettingsItem = null;
}
function openCardSettings(item) {
  activeSettingsItem = item;
  tagInput.value = item.tag || "";
  colorSection.hidden = item.item_type !== "folder";
  settingsOverlay.hidden = false;
  closeNavPanels();
}
document.getElementById("card-settings-close").addEventListener("click", closeCardSettings);
document.getElementById("card-settings-cancel").addEventListener("click", closeCardSettings);
settingsOverlay.addEventListener("click", event => {
  if (event.target === settingsOverlay) closeCardSettings();
});
document.getElementById("folder-color-options").addEventListener("click", async (event) => {
  const choice = event.target.closest("[data-color]");
  if (!choice || !activeSettingsItem || activeSettingsItem.item_type !== "folder") return;
  try {
    await queueFileMutation(
        "metadata", activeSettingsItem.id, {folder_color: choice.dataset.color});
    closeCardSettings();
  } catch (error) {
    alert("Could not update folder colour: " + error.message);
  }
});
tagInput.addEventListener("change", async () => {
  if (!activeSettingsItem) return;
  try {
    await queueFileMutation(
        "metadata", activeSettingsItem.id, {tag: tagInput.value.trim() || null});
  } catch (error) {
    alert("Could not save tag: " + error.message);
  }
});
document.getElementById("card-settings-delete").addEventListener("click", async () => {
  if (!activeSettingsItem) return;
  const item = activeSettingsItem;
  const confirmed = confirm(
      "Delete “" + item.name + "”" +
      (item.item_type === "folder" ? " and everything inside it" : "") + "?");
  if (!confirmed) return;
  try {
    await queueFileMutation("delete", item.id, {});
    closeCardSettings();
  } catch (error) {
    alert("Could not delete item: " + error.message);
  }
});
document.getElementById("files-search-input").addEventListener("input", event => {
  searchQuery = event.target.value.trim().toLocaleLowerCase();
  renderItems();
});
document.getElementById("files-toggle").addEventListener("click", () => {
  closeNavPanels();
  if (activeSharedBucket) {
    activeSharedBucket = null;
    items = ownedItems;
    currentFolderId = exhibitionRootId;
    clearSelection();
    renderItems();
  } else if (currentFolderId)
    openFolder(null);
});
// Load, cache, and display workspace items.
function setUploadProgress(done, total, detail) {
  const percent = total ? Math.round(done / total * 100) : 0;
  if (!uploadMinimised) uploadOverlay.hidden = false;
  uploadDetail.textContent = detail || ("Uploading " + done + " of " + total);
  uploadProgress.style.width = percent + "%";
  uploadMiniBar.style.width = percent + "%";
  uploadMiniPercent.textContent = percent + "%";
}
function hideUploadProgress() {
  uploadOverlay.hidden = true;
  uploadMini.hidden = true;
  uploadProgress.style.width = "0%";
  uploadMiniBar.style.width = "0%";
  uploadMinimised = false;
  activeUploadController = null;
  uploadCancelled = false;
}
async function loadItems({force = false} = {}) {
  const cached = !force ? readWorkspaceCache() : null;
  const cacheIsFresh = cached && cached.rootId === exhibitionRootId;
  if (cacheIsFresh) {
    items = cached.items;
    ownedItems = items;
    exhibitionRecords = Array.isArray(cached.exhibitions) ? cached.exhibitions : [];
    exhibitionTotalBytes = Number(cached.totalBytes) || 0;
    sharedBucketRecords = Array.isArray(cached.sharedBuckets) ? cached.sharedBuckets : [];
    workspaceCacheTimestamp = Number(cached.savedAt) || Date.now();
    lastItemsLoad = workspaceCacheTimestamp;
  } else {
    const data = await filesAction("list");
    items = data.items || [];
    ownedItems = items;
    workspaceCacheTimestamp = Date.now();
    lastItemsLoad = workspaceCacheTimestamp;
  }
  await applyPendingToCache();
  ownedItems = items;
  if (activeSharedBucket) {
    try {
      const shared = await filesAction("shared_bucket_open", {bucketId: activeSharedBucket.id});
      items = shared.items || [];
    } catch (error) {
      activeSharedBucket = null;
      items = ownedItems;
      currentFolderId = exhibitionRootId;
    }
  } else
    items = ownedItems;
  lastItemsLoad = workspaceCacheTimestamp || Date.now();
  writeWorkspaceCache();
  const valid = new Set(items.map(item => item.id));
  for (const id of [...selectedIds])
    if (!valid.has(id)) selectedIds.delete(id);
  renderItems();
  // Warm every owned PDF preview in the background, without waiting for its
  // folder to be opened. Existing IndexedDB previews are instant cache hits.
  scheduleBackgroundPdfPreviews(ownedItems);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || Date.now() - lastItemsLoad < 5 * 60 * 1000) return;
  checkForWorkspaceChanges().catch(
      error => console.warn("Could not check for bucket changes after returning to this tab:", error.message));
});
function upsertItem(item) {
  if (!item || typeof item.id !== "string") return null;
  const existing = items.find(entry => entry.id === item.id);
  if (existing) {
    Object.assign(existing, item);
    return existing;
  }
  items.push(item);
  return item;
}
function removeCachedItems(ids) {
  const removed = new Set(ids.filter(id => typeof id === "string" && id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parent_id && removed.has(item.parent_id) && !removed.has(item.id)) {
        removed.add(item.id);
        changed = true;
      }
    }
  }
  items = items.filter(item => !removed.has(item.id));
  for (const id of removed) selectedIds.delete(id);
  if (currentFolderId && removed.has(currentFolderId)) currentFolderId = null;
}
function visibleItems() {
  return items.filter(
      item => item.parent_id === currentFolderId &&
          item.name.toLocaleLowerCase().includes(searchQuery));
}
function resetCardMotion() {
  list.querySelectorAll(".file-card").forEach(card => {
    card.style.setProperty("--card-scale", "1");
    card.style.setProperty("--card-z", "1");
  });
}
// Multi-select, drag selection, and touch gestures.
const selectionActions = document.getElementById("selection-actions");
const selectionColors = document.getElementById("selection-colors");
const selectionRecolour = document.getElementById("selection-recolour");
function positionSelectionActions() {
  if (!selectedIds.size || marqueeStart) {
    selectionActions.hidden = true;
    return;
  }
  const selectedCards = [...list.querySelectorAll(".file-card.is-selected")];
  if (!selectedCards.length) {
    selectionActions.hidden = true;
    return;
  }
  const rects = selectedCards.map(card => card.getBoundingClientRect());
  const right = Math.max(...rects.map(rect => rect.right));
  const top = Math.min(...rects.map(rect => rect.top));
  const bottom = Math.max(...rects.map(rect => rect.bottom));
  selectionActions.hidden = false;
  const toolbarHeight = selectionActions.offsetHeight || 32;
  selectionActions.style.left = Math.min(window.innerWidth - 220, Math.max(8, right)) + "px";
  selectionActions.style.top =
      Math.max(12, Math.min(window.innerHeight - toolbarHeight - 12, (top + bottom) / 2)) + "px";
  const hasFolders = selectedCards.some(card => card.dataset.type === "folder");
  selectionRecolour.hidden = !hasFolders;
}
function updateSelectionUi() {
  if (activeSharedBucket) {
    selectedIds.clear();
    document.body.classList.remove("has-selection", "selection-drag-mode");
    selectionActions.hidden = true;
    selectionColors.hidden = true;
    list.querySelectorAll(".file-card").forEach(card => {
      card.classList.remove("is-selected");
      card.draggable = false;
    });
    return;
  }
  document.body.classList.toggle("has-selection", selectedIds.size > 0);
  list.querySelectorAll(".file-card").forEach(card => {
    card.classList.toggle("is-selected", selectedIds.has(card.dataset.id));
    card.draggable = true;
  });
  if (!selectedIds.size) {
    selectionActions.hidden = true;
    selectionColors.hidden = true;
  } else
    requestAnimationFrame(positionSelectionActions);
}
document.getElementById("selection-recolour").addEventListener("click", () => {
  selectionColors.hidden = !selectionColors.hidden;
});
document.getElementById("selection-delete").addEventListener("click", async () => {
  const ids = await topLevelIds([...selectedIds]);
  if (!ids.length) return;
  const count = selectedIds.size;
  if (!confirm(
          "Delete " + count + " selected item" + (count === 1 ? "" : "s") +
          "? This cannot be undone."))
    return;
  try {
    for (const id of ids) await queueFileMutation("delete", id, {});
    clearSelection();
    renderItems();
  } catch (error) {
    renderItems();
    alert("Could not queue the selected items for deletion: " + error.message);
  }
});
selectionColors.addEventListener("click", async (event) => {
  const choice = event.target.closest("[data-color]");
  if (!choice) return;
  const color = choice.dataset.color;
  const folders = [...selectedIds]
                      .map(id => items.find(item => item.id === id))
                      .filter(item => item?.item_type === "folder");
  if (!folders.length) return;
  try {
    for (const folder of folders)
      await queueFileMutation("metadata", folder.id, {folder_color: color});
    clearSelection();
    renderItems();
  } catch (error) {
    renderItems();
    alert("Could not queue the folder colour changes: " + error.message);
  }
});
window.addEventListener("resize", () => {
  if (selectedIds.size) positionSelectionActions();
});
window.addEventListener("scroll", () => {
  if (selectedIds.size) positionSelectionActions();
}, true);
function clearSelection() {
  selectedIds.clear();
  document.body.classList.remove("has-selection", "selection-drag-mode");
  updateSelectionUi();
}
function isEmptyCanvasTarget(target) {
  if (activeSharedBucket || !(target instanceof Element) || !main.contains(target)) return false;
  return !target.closest(
      ".file-card,.add-wrap,button,a,input,textarea,select,.panel,.file-viewer,.confirm-overlay,.upload-overlay,.drop-hint");
}
function setMarqueeRect(x, y) {
  if (!marqueeStart) return;
  const left = Math.min(marqueeStart.x, x);
  const top = Math.min(marqueeStart.y, y);
  marquee.style.left = left + "px";
  marquee.style.top = top + "px";
  marquee.style.width = Math.abs(x - marqueeStart.x) + "px";
  marquee.style.height = Math.abs(y - marqueeStart.y) + "px";
}
function beginMarquee(x, y) {
  selectedIds.clear();
  updateSelectionUi();
  marqueeStart = {x, y};
  marquee.hidden = false;
  setMarqueeRect(x, y);
  document.body.classList.add("selection-drag-mode");
}
function updateMarquee(x, y) {
  if (!marqueeStart) return;
  setMarqueeRect(x, y);
  const left = Math.min(marqueeStart.x, x);
  const top = Math.min(marqueeStart.y, y);
  const box = {
    left,
    top,
    right: left + Math.abs(x - marqueeStart.x),
    bottom: top + Math.abs(y - marqueeStart.y)
  };
  selectedIds.clear();
  list.querySelectorAll(".file-card").forEach(card => {
    const rect = card.getBoundingClientRect();
    if (rect.left < box.right && rect.right > box.left && rect.top < box.bottom &&
        rect.bottom > box.top) {
      selectedIds.add(card.dataset.id);
    }
  });
  updateSelectionUi();
}
function finishMarquee() {
  if (!marqueeStart) return;
  marqueeStart = null;
  marquee.hidden = true;
  document.body.classList.remove("selection-drag-mode");
  updateSelectionUi();
}
function isDoubleTap(previous, x, y, pointerType) {
  return !!previous && previous.pointerType === pointerType &&
      Date.now() - previous.time <= DOUBLE_TAP_WINDOW &&
      Math.hypot(previous.x - x, previous.y - y) <= DOUBLE_TAP_DISTANCE;
}
// Mouse and pen: a second press on empty space starts the drag-selection rectangle.
main.addEventListener("pointerdown", event => {
  if (event.pointerType === "touch" || event.button !== 0) return;
  if (!isEmptyCanvasTarget(event.target)) {
    previousPointerTap = null;
    pointerTapCandidate = null;
    return;
  }
  if (isDoubleTap(previousPointerTap, event.clientX, event.clientY, event.pointerType)) {
    event.preventDefault();
    previousPointerTap = null;
    pointerTapCandidate = null;
    activePointerMarquee = {pointerId: event.pointerId};
    beginMarquee(event.clientX, event.clientY);
    try {
      main.setPointerCapture(event.pointerId);
    } catch {
    }
    return;
  }
  pointerTapCandidate = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    x: event.clientX,
    y: event.clientY,
    moved: false
  };
});
document.addEventListener("pointermove", event => {
  if (activePointerMarquee && activePointerMarquee.pointerId === event.pointerId) {
    event.preventDefault();
    updateMarquee(event.clientX, event.clientY);
    return;
  }
  if (pointerTapCandidate && pointerTapCandidate.pointerId === event.pointerId &&
      Math.hypot(event.clientX - pointerTapCandidate.x, event.clientY - pointerTapCandidate.y) >
          GESTURE_MOVE_THRESHOLD) {
    pointerTapCandidate.moved = true;
  }
});
document.addEventListener("pointerup", event => {
  if (activePointerMarquee && activePointerMarquee.pointerId === event.pointerId) {
    finishMarquee();
    activePointerMarquee = null;
    return;
  }
  if (pointerTapCandidate && pointerTapCandidate.pointerId === event.pointerId) {
    const tap = pointerTapCandidate;
    pointerTapCandidate = null;
    if (!tap.moved) {
      if (selectedIds.size) clearSelection();
      previousPointerTap = {x: tap.x, y: tap.y, time: Date.now(), pointerType: tap.pointerType};
    } else
      previousPointerTap = null;
  }
});
document.addEventListener("pointercancel", event => {
  if (activePointerMarquee && activePointerMarquee.pointerId === event.pointerId) {
    finishMarquee();
    activePointerMarquee = null;
  }
  if (pointerTapCandidate?.pointerId === event.pointerId) pointerTapCandidate = null;
  previousPointerTap = null;
});
// Touch: single taps still scroll normally. Only the second tap arms marquee dragging.
main.addEventListener("touchstart", event => {
  if (event.touches.length !== 1) return;
  const touch = event.changedTouches[0];
  if (!isEmptyCanvasTarget(event.target)) {
    previousTouchTap = null;
    touchTapCandidate = null;
    return;
  }
  if (previousTouchTap && Date.now() - previousTouchTap.time <= DOUBLE_TAP_WINDOW &&
      Math.hypot(previousTouchTap.x - touch.clientX, previousTouchTap.y - touch.clientY) <=
          DOUBLE_TAP_DISTANCE) {
    event.preventDefault();
    previousTouchTap = null;
    touchTapCandidate = null;
    activeTouchMarqueeId = touch.identifier;
    beginMarquee(touch.clientX, touch.clientY);
    return;
  }
  touchTapCandidate =
      {identifier: touch.identifier, x: touch.clientX, y: touch.clientY, moved: false};
}, {passive: false});
main.addEventListener("touchmove", event => {
  if (activeTouchMarqueeId !== null) {
    const touch = [...event.touches].find(value => value.identifier === activeTouchMarqueeId);
    if (touch) {
      event.preventDefault();
      updateMarquee(touch.clientX, touch.clientY);
    }
    return;
  }
  if (touchTapCandidate) {
    const touch =
        [...event.touches].find(value => value.identifier === touchTapCandidate.identifier);
    if (touch &&
        Math.hypot(touch.clientX - touchTapCandidate.x, touch.clientY - touchTapCandidate.y) >
            GESTURE_MOVE_THRESHOLD) {
      touchTapCandidate.moved = true;
    }
  }
}, {passive: false});
main.addEventListener("touchend", event => {
  if (activeTouchMarqueeId !== null &&
      [...event.changedTouches].some(touch => touch.identifier === activeTouchMarqueeId)) {
    event.preventDefault();
    activeTouchMarqueeId = null;
    finishMarquee();
    return;
  }
  if (touchTapCandidate &&
      [...event.changedTouches].some(touch => touch.identifier === touchTapCandidate.identifier)) {
    const tap = touchTapCandidate;
    touchTapCandidate = null;
    if (!tap.moved) {
      if (selectedIds.size) clearSelection();
      previousTouchTap = {x: tap.x, y: tap.y, time: Date.now()};
    } else
      previousTouchTap = null;
  }
}, {passive: false});
main.addEventListener("touchcancel", () => {
  touchTapCandidate = null;
  previousTouchTap = null;
  if (activeTouchMarqueeId !== null) {
    activeTouchMarqueeId = null;
    finishMarquee();
  }
}, {passive: true});
// PDF preview generation and local preview cache.
const pdfPreviewCache = new Map();
const pdfPreviewRequests = new Map();
const PDF_THUMB_DB = "coolanas-pdf-thumbnails";
const PDF_THUMB_STORE = "previews";
let pdfThumbDbPromise = null;
function openPdfThumbDb() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  if (!pdfThumbDbPromise) {
    pdfThumbDbPromise = new Promise(resolve => {
      const request = indexedDB.open(PDF_THUMB_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PDF_THUMB_STORE))
          request.result.createObjectStore(PDF_THUMB_STORE, {keyPath: "id"});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return pdfThumbDbPromise;
}
function pdfThumbVersion(item) {
  return String(item.updated_at || item.updatedAt || item.storage_path || "") + ":" +
      String(item.size_bytes || item.size || "");
}
async function readPdfThumb(item) {
  const db = await openPdfThumbDb();
  if (!db) return null;
  return new Promise(resolve => {
    const request =
        db.transaction(PDF_THUMB_STORE, "readonly").objectStore(PDF_THUMB_STORE).get(item.id);
    request.onsuccess = () =>
        resolve(request.result?.version === pdfThumbVersion(item) ? request.result.dataUrl : null);
    request.onerror = () => resolve(null);
  });
}
async function savePdfThumb(item, dataUrl) {
  const db = await openPdfThumbDb();
  if (!db) return;
  await new Promise(resolve => {
    const tx = db.transaction(PDF_THUMB_STORE, "readwrite");
    tx.objectStore(PDF_THUMB_STORE)
        .put({id: item.id, version: pdfThumbVersion(item), dataUrl, savedAt: Date.now()});
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
}
let pdfJsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfJsPromise) {
    pdfJsPromise =
        new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
          script.async = true;
          script.onload = () => {
            if (!window.pdfjsLib) {
              reject(new Error("PDF.js loaded without its rendering API."));
              return;
            }
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
            resolve(window.pdfjsLib);
          };
          script.onerror = () => reject(new Error("Could not load the PDF rendering library."));
          document.head.append(script);
        }).catch(error => {
          pdfJsPromise = null;
          throw error;
        });
  }
  return pdfJsPromise;
}
function paintPdfThumbnail(itemId, dataUrl) {
  document.querySelectorAll(".pdf-thumbnail").forEach(container => {
    if (container.dataset.pdfId !== itemId) return;
    const image = document.createElement("img");
    image.alt = "First page preview of PDF";
    image.src = dataUrl;
    container.replaceChildren(image);
    container.classList.remove("pdf-preview-error");
  });
}
async function createPdfThumbnail(item) {
  if (pdfPreviewCache.has(item.id)) return pdfPreviewCache.get(item.id);
  if (pdfPreviewRequests.has(item.id)) return pdfPreviewRequests.get(item.id);
  const request =
      (async () => {
        const persisted = await readPdfThumb(item);
        if (persisted) {
          pdfPreviewCache.set(item.id, persisted);
          return persisted;
        }
        const signed = await filesAction("file_preview", {id: item.id});
        // Give PDF.js the signed URL and let it request only the byte ranges
        // needed for page 1. Streaming and automatic background fetching are
        // disabled so opening a thumbnail does not download the entire PDF.
        const pdfjs = await loadPdfJs();
        const loading = pdfjs.getDocument({
          url: signed.downloadUrl,
          rangeChunkSize: 32768,
          disableRange: false,
          disableStream: true,
          disableAutoFetch: true,
          isEvalSupported: false,
          useWorkerFetch: false
        });
        const pdf = await loading.promise;
        try {
          const page = await pdf.getPage(1);
          const original = page.getViewport({scale: 1});
          const viewport =
              page.getViewport({scale: Math.min(1, 138 / original.width, 138 / original.height)});
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          const context = canvas.getContext("2d", {alpha: false});
          if (!context) throw new Error("PDF preview canvas is unavailable.");
          context.fillStyle = "#fff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({canvasContext: context, viewport}).promise;
          const dataUrl = canvas.toDataURL("image/jpeg", .82);
          pdfPreviewCache.set(item.id, dataUrl);
          if (pdfPreviewCache.size > 120)
            pdfPreviewCache.delete(pdfPreviewCache.keys().next().value);
          savePdfThumb(item, dataUrl)
              .catch(error => console.warn("Could not persist PDF thumbnail:", error.message));
          return dataUrl;
        } finally {
          await pdf.destroy();
        }
      })().finally(() => pdfPreviewRequests.delete(item.id));
  pdfPreviewRequests.set(item.id, request);
  return request;
}
async function renderPdfThumbnail(item, container) {
  try {
    const dataUrl = await createPdfThumbnail(item);
    if (container.isConnected) paintPdfThumbnail(item.id, dataUrl);
  } catch (error) {
    if (container.isConnected) {
      container.classList.add("pdf-preview-error");
      container.title = "PDF preview unavailable: " + (error?.message || "unknown error");
      const placeholder = document.createElement("span");
      placeholder.className = "pdf-thumbnail-placeholder";
      placeholder.textContent = "PDF";
      container.replaceChildren(placeholder);
    }
    console.warn("Could not render PDF thumbnail:", item.name, error.message);
  }
}
const pdfPreviewQueue = [];
let activePdfPreviews = 0;
function pumpPdfPreviewQueue() {
  while (activePdfPreviews < 3 && pdfPreviewQueue.length) {
    const job = pdfPreviewQueue.shift();
    activePdfPreviews++;
    renderPdfThumbnail(job.item, job.container).finally(() => {
      activePdfPreviews--;
      pumpPdfPreviewQueue();
    });
  }
}
function queuePdfThumbnail(item, container) {
  container.dataset.pdfId = item.id;
  if (pdfPreviewCache.has(item.id)) {
    paintPdfThumbnail(item.id, pdfPreviewCache.get(item.id));
    return;
  }
  if (pdfPreviewRequests.has(item.id)) return;
  pdfPreviewQueue.push({item, container});
  pumpPdfPreviewQueue();
}
const backgroundPdfIds = new Set();
let backgroundPdfQueue = [];
let backgroundPdfWorkers = 0;
let backgroundPdfScheduled = false;
function scheduleBackgroundPdfPreviews(sourceItems) {
  const pdfs = sourceItems.filter(item => item.item_type === "file" && /\.pdf$/i.test(item.name));
  for (const item of pdfs) {
    if (pdfPreviewCache.has(item.id) || pdfPreviewRequests.has(item.id) ||
        backgroundPdfIds.has(item.id))
      continue;
    backgroundPdfIds.add(item.id);
    backgroundPdfQueue.push(item);
  }
  if (backgroundPdfQueue.length && !backgroundPdfScheduled) {
    backgroundPdfScheduled = true;
    const start = () => {
      backgroundPdfScheduled = false;
      pumpBackgroundPdfPreviews();
    };
    if ("requestIdleCallback" in window)
      requestIdleCallback(start, {timeout: 2500});
    else
      setTimeout(start, 1200);
  }
}
function pumpBackgroundPdfPreviews() {
  if (document.visibilityState === "hidden") return;
  while (backgroundPdfWorkers < 2 && backgroundPdfQueue.length) {
    const item = backgroundPdfQueue.shift();
    backgroundPdfWorkers++;
    createPdfThumbnail(item)
        .catch(error => {
          console.warn("Background PDF preview failed:", item.name, error.message);
        })
        .finally(() => {
          backgroundPdfWorkers--;
          backgroundPdfIds.delete(item.id);
          if (backgroundPdfQueue.length) {
            setTimeout(pumpBackgroundPdfPreviews, 350);
          }
        });
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && backgroundPdfQueue.length)
    pumpBackgroundPdfPreviews();
});
// Render the current folder and its file cards.
function renderItems() {
  writeWorkspaceCache();
  list.replaceChildren();
  const folder = items.find(item => item.id === currentFolderId);
  const isExhibitionsHome = !!exhibitionRootId && currentFolderId === exhibitionRootId;
  document.getElementById("exhibitions-header").hidden = !isExhibitionsHome;
  document.getElementById("shared-buckets").hidden = !isExhibitionsHome;
  toolbar.hidden = !currentFolderId || isExhibitionsHome;
  currentFolder.textContent = activeSharedBucket ?
      ((folder?.name || activeSharedBucket.name) + " · Shared by " +
       activeSharedBucket.ownerUsername + " · Read-only · " +
       (activeSharedBucket.permission === "view" ? "View only" : "View and download")) :
      (folder?.name || "");
  const ordered = visibleItems().sort((a, b) => {
    const type = (a.item_type === "folder" ? 0 : 1) - (b.item_type === "folder" ? 0 : 1);
    return type || (Number(a.sort_order || 0) - Number(b.sort_order || 0)) ||
        a.name.localeCompare(b.name);
  });
  for (const item of ordered) {
    const card = document.createElement("div");
    const isBucketCard = isExhibitionsHome && item.item_type === "folder";
    card.className = "file-card" + (isBucketCard ? " bucket-card" : "");
    card.tabIndex = 0;
    const isReadOnlyShared = Boolean(activeSharedBucket);
    card.draggable = !isReadOnlyShared;
    card.dataset.id = item.id;
    card.dataset.type = item.item_type;
    card.setAttribute("role", "listitem");
    const isPdfFile = item.item_type === "file" && /\.pdf$/i.test(item.name);
    card.innerHTML = item.item_type === "folder" ? (isBucketCard ? bucketSvg : folderSvg) :
                                                   (isPdfFile ? "" : fileSvg);
    const icon = card.querySelector("svg");
    if (item.item_type === "folder" && item.folder_color) icon.style.color = item.folder_color;
    if (isPdfFile) {
      card.classList.add("pdf-file-card");
      const thumbnail = document.createElement("div");
      thumbnail.className = "pdf-thumbnail";
      thumbnail.setAttribute("aria-label", "PDF first page preview");
      const placeholder = document.createElement("span");
      placeholder.className = "pdf-thumbnail-placeholder";
      placeholder.textContent = "PDF";
      thumbnail.append(placeholder);
      card.append(thumbnail);
      queuePdfThumbnail(item, thumbnail);
    }
    let settings = null;
    if (!isReadOnlyShared) {
      settings = document.createElement("button");
      settings.type = "button";
      settings.className = "settings-dot";
      settings.title = "Item settings";
      settings.setAttribute("aria-label", "Settings for " + item.name);
      settings.addEventListener("click", event => {
        event.stopPropagation();
        openCardSettings(item);
      });
    }
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = item.name;
    let share = null;
    if (isBucketCard) {
      share = document.createElement("button");
      share.type = "button";
      share.className = "share-dot";
      share.title = "Share bucket";
      share.setAttribute("aria-label", "Share bucket " + item.name);
      share.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        openBucketSharePanel(item);
      });
      const details = document.createElement("div");
      details.className = "bucket-details";
      const meta = document.createElement("div");
      meta.className = "bucket-meta";
      meta.append(name);
      const exhibition = exhibitionRecords.find(entry => entry.id === item.id);
      const size = document.createElement("span");
      size.className = "exhibition-size";
      size.textContent = formatStorage(exhibition?.sizeBytes || 0);
      meta.append(size);
      const actions = document.createElement("div");
      actions.className = "bucket-actions";
      actions.setAttribute("aria-label", "Bucket actions");
      if (settings) actions.append(settings);
      actions.append(share);
      details.append(meta, actions);
      card.append(details);
    } else {
      if (settings) card.append(settings);
      if (isExhibitionsHome) {
        const exhibition = exhibitionRecords.find(entry => entry.id === item.id);
        const size = document.createElement("span");
        size.className = "exhibition-size";
        size.textContent = formatStorage(exhibition?.sizeBytes || 0);
        card.append(name, size);
      } else
        card.append(name);
    }
    if (item.tag) {
      const tag = document.createElement("span");
      tag.className = "file-tag";
      tag.textContent = item.tag;
      card.append(tag);
    }
    card.addEventListener("click", event => {
      if (card.dataset.dragged === "true") {
        card.dataset.dragged = "false";
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedIds.size) clearSelection();
      if (item.item_type === "folder")
        openFolder(item.id);
      else
        openFile(item);
    });
    card.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (item.item_type === "folder")
          openFolder(item.id);
        else
          openFile(item);
      }
    });
    if (!isReadOnlyShared) {
      card.addEventListener("dragstart", event => {
        // Dragging any selected card carries the entire marquee selection.
        internalDragIds =
            selectedIds.has(item.id) && selectedIds.size ? [...selectedIds] : [item.id];
        if (!selectedIds.has(item.id) && selectedIds.size) clearSelection();
        card.dataset.dragged = "true";
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-coolanas-items", JSON.stringify(internalDragIds));
        event.dataTransfer.setData("text/plain", internalDragIds.join(","));
        requestAnimationFrame(() => {
          card.classList.add("is-being-dragged");
          list.classList.add("is-rearranging");
        });
      });
      card.addEventListener("dragend", () => {
        internalDragIds = [];
        list.classList.remove("is-rearranging");
        list.querySelectorAll(".is-being-dragged,.is-drop-target")
            .forEach(node => node.classList.remove("is-being-dragged", "is-drop-target"));
      });
      card.addEventListener("dragover", event => {
        if (internalDragIds.length && item.item_type === "folder" &&
            !internalDragIds.includes(item.id)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          card.classList.add("is-drop-target");
        } else if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          if (item.item_type === "folder") card.classList.add("is-drop-target");
        }
      });
      card.addEventListener("dragleave", () => card.classList.remove("is-drop-target"));
      card.addEventListener("drop", async (event) => {
        event.preventDefault();
        card.classList.remove("is-drop-target");
        if (internalDragIds.length) {
          const ids = [...internalDragIds];
          if (item.item_type === "folder")
            await moveItems(ids, item.id);
          else
            await reorderBefore(ids, item.id);
          return;
        }
        if (event.dataTransfer.files?.length) {
          const target = item.item_type === "folder" ? item.id : currentFolderId;
          await handleExternalDrop(event.dataTransfer, target);
        }
      });
    }
    list.append(card);
  }
  addWrap.hidden = isExhibitionsHome || Boolean(activeSharedBucket);
  if (!isExhibitionsHome) list.append(addWrap);
  updateSelectionUi();
  resetCardMotion();
}
// Navigate folders and open shared buckets.
function openFolder(id) {
  clearSelection();
  currentFolderId = id;
  renderItems();
}
async function openSharedBucket(bucket) {
  activeSharedBucket = {
    id: bucket.id,
    name: bucket.name,
    ownerUsername: bucket.ownerUsername || "Coolanas user",
    permission: bucket.permission || "view_download"
  };
  currentFolderId = bucket.id;
  searchQuery = "";
  clearSelection();
  const cachedItems = sharedFolderCache[bucket.id]?.items;
  items = Array.isArray(cachedItems) ? cachedItems : [];
  renderItems();
  try {
    const result = await filesAction("shared_bucket_open", {bucketId: bucket.id});
    const nextItems = result.items || [];
    activeSharedBucket.permission = result.permission || activeSharedBucket.permission;
    if (JSON.stringify(nextItems) !== JSON.stringify(items)) {
      items = nextItems;
      renderItems();
    }
    sharedFolderCache[bucket.id] = {items: nextItems, savedAt: Date.now()};
    writeWorkspaceCache();
  } catch (error) {
    if (!cachedItems?.length)
      document.getElementById("shared-buckets-feedback").textContent =
          error.message || "Could not open shared bucket.";
  }
}
document.getElementById("back-folder").addEventListener("click", () => {
  if (activeSharedBucket && currentFolderId === activeSharedBucket.id) {
    activeSharedBucket = null;
    items = ownedItems;
    currentFolderId = exhibitionRootId;
  } else {
    currentFolderId = items.find(item => item.id === currentFolderId)?.parent_id ||
        activeSharedBucket?.id || null;
  }
  clearSelection();
  renderItems();
});
const addWrap = document.createElement("div");
addWrap.className = "add-wrap";
addWrap.innerHTML =
    "<button class=\"add-button\" id=\"add-toggle\" type=\"button\" aria-label=\"Add files or folders\" aria-expanded=\"false\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"><path d=\"M12 5v14M5 12h14\"/></svg></button><div class=\"add-menu\" id=\"add-menu\" hidden><button class=\"add-option\" type=\"button\" id=\"upload-option\">Upload files</button><button class=\"add-option\" type=\"button\" id=\"upload-folder-option\">Upload folder</button><button class=\"add-option\" type=\"button\" id=\"new-folder-option\">New folder</button></div>";

function formatStorage(bytes) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return value.toFixed(index === 0 ? 0 : 2) + " " + units[index];
}
async function refreshSharedBuckets({force = false, cacheOnly = false, silent = false} = {}) {
  const grid = document.getElementById("shared-buckets-list");
  const ownerGrid = document.getElementById("shared-by-you-list");
  const ownerTitle = document.getElementById("shared-by-you-title");
  try {
    const cached = readWorkspaceCache();
    const hasCachedShares = cached && cached.rootId === exhibitionRootId &&
        Array.isArray(cached.sharedBuckets) && Array.isArray(cached.sharedByYou);
    const result = cacheOnly && hasCachedShares ?
        {buckets: cached.sharedBuckets, sharedByYou: cached.sharedByYou} :
        !force && hasCachedShares && Date.now() - Number(cached.metadataSavedAt || 0) < workspaceCacheMaxAge ?
            {buckets: cached.sharedBuckets, sharedByYou: cached.sharedByYou} :
            cacheOnly ? {buckets: sharedBucketRecords, sharedByYou: sharedByYouRecords} :
            await filesAction("shared_buckets_list");
    if (!cacheOnly && (!hasCachedShares || force ||
        Date.now() - Number(cached?.metadataSavedAt || 0) >= workspaceCacheMaxAge))
      metadataCacheTimestamp = Date.now();
    sharedBucketRecords = result.buckets || [];
    sharedByYouRecords = result.sharedByYou || [];
    const sharedByYou = sharedByYouRecords;
    const signature = JSON.stringify({received: sharedBucketRecords, owned: sharedByYou});
    if (signature === renderedSharedBucketsSignature) return;
    renderedSharedBucketsSignature = signature;
    grid.replaceChildren();
    ownerGrid.replaceChildren();
    if (!sharedBucketRecords.length) {
      const empty = document.createElement("p");
      empty.className = "shared-bucket-empty";
      empty.textContent = "No buckets shared with you yet";
      grid.append(empty);
    }
    for (const bucket of sharedBucketRecords) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "shared-bucket-card";
      const icon = document.createElement("span");
      icon.innerHTML = bucketSvg;
      const svg = icon.firstElementChild;
      if (bucket.folder_color) svg.style.color = bucket.folder_color;
      const name = document.createElement("span");
      name.className = "shared-bucket-name";
      name.textContent = bucket.name;
      const owner = document.createElement("span");
      owner.className = "shared-bucket-owner";
      owner.textContent = "Shared by " + bucket.ownerUsername;
      card.append(svg, name, owner);
      card.addEventListener("click", () => openSharedBucket(bucket));
      grid.append(card);
    }
    ownerTitle.hidden = !sharedByYou.length;
    if (!sharedByYou.length) {
      const empty = document.createElement("p");
      empty.className = "shared-bucket-empty";
      empty.textContent = "You have not shared any buckets yet";
      ownerGrid.append(empty);
    }
    for (const bucket of sharedByYou) {
      const card = document.createElement("div");
      card.className = "shared-bucket-card-owner";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "shared-bucket-card-open";
      const icon = document.createElement("span");
      icon.innerHTML = bucketSvg;
      const svg = icon.firstElementChild;
      if (bucket.folder_color) svg.style.color = bucket.folder_color;
      const name = document.createElement("span");
      name.className = "shared-bucket-name";
      name.textContent = bucket.name;
      const status = document.createElement("span");
      status.className = "shared-bucket-owner-status";
      status.textContent = "You shared this";
      open.append(svg, name, status);
      open.addEventListener("click", () => openFolder(bucket.id));
      const wrap = document.createElement("div");
      wrap.className = "shared-bucket-manage-wrap";
      const manage = document.createElement("button");
      manage.type = "button";
      manage.className = "shared-bucket-manage";
      manage.setAttribute("aria-label", "Manage sharing for " + bucket.name);
      manage.title = "Manage sharing";
      const menu = document.createElement("div");
      menu.className = "shared-bucket-menu";
      menu.hidden = true;
      manage.addEventListener("click", event => {
        event.stopPropagation();
        document.querySelectorAll(".shared-bucket-menu").forEach(other => {
          if (other !== menu) other.hidden = true;
        });
        menu.hidden = !menu.hidden;
      });
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke access";
      revoke.addEventListener("click", event => {
        event.stopPropagation();
        menu.hidden = true;
        openBucketSharePanel(bucket, "revoke");
      });

      const permission = document.createElement("button");
      permission.type = "button";
      permission.textContent = "Change permission";
      permission.addEventListener("click", event => {
        event.stopPropagation();
        menu.hidden = true;
        openBucketSharePanel(bucket, "permission");
      });

      menu.append(revoke, permission);
      wrap.append(manage, menu);
      card.append(open, wrap);
      ownerGrid.append(card);
    }
  } catch (error) {
    if (!silent && !sharedBucketRecords.length) {
      grid.replaceChildren();
      ownerGrid.replaceChildren();
      ownerTitle.hidden = true;
      const empty = document.createElement("p");
      empty.className = "shared-bucket-empty";
      empty.textContent = "Could not load shared buckets.";
      grid.append(empty);
    }
    if (!silent) document.getElementById("shared-buckets-feedback").textContent = error.message || "";
  }
}
// Share buckets and manage invitations.
const sharePanel = document.getElementById("bucket-share-panel");
const shareSearch = document.getElementById("bucket-share-search");
const shareUsers = document.getElementById("bucket-share-users");
const shareConfirmOverlay = document.getElementById("share-confirm-overlay");
let shareUserRecords = [], shareConfirmTarget = null, sharePanelMode = "share";
function closeBucketSharePanel() {
  sharePanel.hidden = true;
  currentShareBucket = null;
  shareSearch.value = "";
  shareUsers.replaceChildren();
  shareSearch.hidden = false;
  shareUsers.hidden = false;
  sharePanelMode = "share";
  document.getElementById("bucket-share-title").textContent = "Share bucket";
}
function renderShareUsers() {
  const query = shareSearch.value.trim().toLocaleLowerCase();
  const matches = shareUserRecords.filter(
      entry => String(entry.username || "").toLocaleLowerCase().includes(query));
  shareUsers.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement("li");
    empty.className = "shared-bucket-empty";
    empty.textContent = query ? "No matching users." : "No other registered users found.";
    shareUsers.append(empty);
    return;
  }
  for (const entry of matches) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "share-user-choice";
    const name = document.createElement("span");
    name.className = "share-user-name";
    name.textContent = entry.username;
    button.append(name);
    button.addEventListener("click", () => openShareConfirmation(entry));
    li.append(button);
    shareUsers.append(li);
  }
}
async function refreshBucketShareAccess() {
  const accessList = document.getElementById("bucket-share-access-list");
  if (!currentShareBucket) return;
  try {
    const result = await filesAction("bucket_share_owner_list", {bucketId: currentShareBucket.id});
    accessList.replaceChildren();
    const entries = [...(result.shares || []), ...(result.invitations || [])];
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "shared-bucket-empty";
      empty.textContent = "Not shared with anyone yet.";
      accessList.append(empty);
    }
    for (const entry of entries) {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.className = "share-access-name";
      text.textContent = entry.username;
      const status = document.createElement("span");
      status.className = "share-access-status";
      status.textContent = entry.status === "pending" ?
          "Invitation pending" :
          (entry.permission === "view" ? "Can view only" : "Can view and download");

      text.append(status);
      if (entry.status === "accepted" && sharePanelMode === "permission") {
        const select = document.createElement("select");
        select.className = "share-permission-select";
        select.setAttribute("aria-label", "Permission for " + entry.username);
        const view = document.createElement("option");
        view.value = "view";
        view.textContent = "View only";
        const download = document.createElement("option");
        download.value = "view_download";
        download.textContent = "View and download";
        select.append(view, download);
        select.value = entry.permission || "view_download";
        select.addEventListener("change", async () => {
          select.disabled = true;
          try {
            await filesAction("bucket_share_permission_update", {
              bucketId: currentShareBucket.id,
              recipientId: entry.recipientId,
              permission: select.value
            });

            document.getElementById("bucket-share-feedback").textContent = "Permission updated.";
            await refreshBucketShareAccess();
            await refreshSharedBuckets();
          } catch (error) {
            document.getElementById("bucket-share-feedback").textContent =
                error.message || "Could not change permission.";
            select.disabled = false;
          }
        });
        li.append(text, select);
      } else if (sharePanelMode !== "permission") {
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "share-revoke";
        revoke.textContent = entry.status === "pending" ? "Cancel" : "Revoke access";
        revoke.addEventListener("click", async () => {
          if (!confirm(
                  (entry.status === "pending" ? "Cancel the invitation to " :
                                                "Revoke access for ") +
                  entry.username + "?"))
            return;
          revoke.disabled = true;
          try {
            await filesAction(
                "bucket_share_revoke",
                {bucketId: currentShareBucket.id, recipientId: entry.recipientId});
            await refreshBucketShareAccess();
            await refreshSharedBuckets();
            document.getElementById("bucket-share-feedback").textContent =
                "Sharing access updated.";
          } catch (error) {
            document.getElementById("bucket-share-feedback").textContent =
                error.message || "Could not revoke access.";
            revoke.disabled = false;
          }
        });
        li.append(text, revoke);
      } else {
        li.append(text);
      }
      accessList.append(li);
    }
  } catch (error) {
    accessList.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "shared-bucket-empty";
    empty.textContent = error.message || "Could not load sharing settings.";
    accessList.append(empty);
  }
}
async function openBucketSharePanel(bucket, mode = "share") {
  currentShareBucket = bucket;
  sharePanelMode = mode;
  document.getElementById("bucket-share-name").textContent = bucket.name;
  document.getElementById("bucket-share-name").style.color = bucket.folder_color || "#555";
  document.getElementById("bucket-share-feedback").textContent = "";
  const titles = {
    share: "Share bucket",
    revoke: "Revoke bucket access",
    permission: "Change bucket permission"
  };
  document.getElementById("bucket-share-title").textContent = titles[mode] || titles.share;
  shareSearch.hidden = mode !== "share";
  shareUsers.hidden = mode !== "share";
  sharePanel.hidden = false;
  const accessList = document.getElementById("bucket-share-access-list");
  accessList.replaceChildren();
  if (mode === "share") {
    shareUsers.replaceChildren();
    const loading = document.createElement("li");
    loading.className = "shared-bucket-empty";
    loading.textContent = "Loading users…";
    shareUsers.append(loading);
    try {
      const result = await filesAction("bucket_share_users");
      shareUserRecords = result.users || [];
      renderShareUsers();
    } catch (error) {
      shareUsers.replaceChildren();
      const empty = document.createElement("li");
      empty.className = "shared-bucket-empty";
      empty.textContent = error.message || "Could not load users.";
      shareUsers.append(empty);
    }
  } else {
    shareUsers.replaceChildren();
  }
  await refreshBucketShareAccess();
}
function openShareConfirmation(entry) {
  if (!currentShareBucket) return;
  shareConfirmTarget = entry;
  const bucketSpan = document.createElement("span");
  bucketSpan.className = "share-confirm-bucket";
  bucketSpan.style.color = currentShareBucket.folder_color || "#2563eb";
  bucketSpan.textContent = currentShareBucket.name;
  const userSpan = document.createElement("span");
  userSpan.className = "share-confirm-user";
  userSpan.textContent = entry.username;
  const message = document.getElementById("share-confirm-message");
  message.replaceChildren(
      document.createTextNode("Are you sure you want to share “"), bucketSpan,
      document.createTextNode("” with “"), userSpan, document.createTextNode("”?"));

  shareConfirmOverlay.hidden = false;
}
document.getElementById("share-confirm-cancel").addEventListener("click", () => {
  shareConfirmOverlay.hidden = true;
  shareConfirmTarget = null;
});

shareConfirmOverlay.addEventListener("click", event => {
  if (event.target === shareConfirmOverlay) {
    shareConfirmOverlay.hidden = true;
    shareConfirmTarget = null;
  }
});
document.getElementById("share-confirm-submit").addEventListener("click", async () => {
  if (!currentShareBucket || !shareConfirmTarget) return;
  const button = document.getElementById("share-confirm-submit");
  button.disabled = true;
  try {
    await filesAction(
        "bucket_share_invite",
        {bucketId: currentShareBucket.id, recipientId: shareConfirmTarget.userId});
    document.getElementById("bucket-share-feedback").textContent =
        "Invitation sent to " + shareConfirmTarget.username + ".";
    shareConfirmOverlay.hidden = true;
    shareConfirmTarget = null;
    await refreshBucketShareAccess();
  } catch (error) {
    document.getElementById("bucket-share-feedback").textContent =
        error.message || "Could not send invitation.";
  } finally {
    button.disabled = false;
  }
});
document.getElementById("bucket-share-close").addEventListener("click", closeBucketSharePanel);
shareSearch.addEventListener("input", renderShareUsers);
document.addEventListener("click", event => {
  if (!sharePanel.hidden && !sharePanel.contains(event.target) &&
      !event.target.closest(".share-dot") && !shareConfirmOverlay.contains(event.target))
    closeBucketSharePanel();
});
// Load the current workspace contents.
async function refreshExhibitions({force = false, silent = false} = {}) {
  const cached = readWorkspaceCache();
  const previousSignature = JSON.stringify({
    exhibitions: exhibitionRecords, totalBytes: exhibitionTotalBytes,
    shared: sharedBucketRecords, sharedByYou: sharedByYouRecords
  });
  const cacheIsFresh = !force && cached && cached.rootId === exhibitionRootId &&
      Array.isArray(cached.exhibitions);
  if (cacheIsFresh) {
    exhibitionRecords = cached.exhibitions;
    exhibitionTotalBytes = Number(cached.totalBytes) || 0;
    sharedBucketRecords = Array.isArray(cached.sharedBuckets) ? cached.sharedBuckets : [];
    sharedByYouRecords = Array.isArray(cached.sharedByYou) ? cached.sharedByYou : [];
    metadataCacheTimestamp = Number(cached.metadataSavedAt) || 0;
    await refreshSharedBuckets({cacheOnly: true, silent});
  } else {
    const data = await filesAction("exhibitions_list");
    exhibitionRecords = data.exhibitions || [];
    exhibitionTotalBytes = Number(data.totalBytes) || 0;
    await refreshSharedBuckets({force: true, silent});
    workspaceCacheTimestamp = Date.now();
    metadataCacheTimestamp = workspaceCacheTimestamp;
  }
  const nextSignature = JSON.stringify({
    exhibitions: exhibitionRecords, totalBytes: exhibitionTotalBytes,
    shared: sharedBucketRecords, sharedByYou: sharedByYouRecords
  });
  writeWorkspaceCache();
  if (previousSignature !== nextSignature || !silent) {
    document.getElementById("bucket-title").textContent =
        "Bucket • " + formatStorage(exhibitionTotalBytes);
    document.getElementById("exhibition-create-form").hidden = exhibitionRecords.length >= 3;
    if (!activeSharedBucket && previousSignature !== nextSignature) renderItems();
  }
}
document.getElementById("exhibition-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("exhibition-name"),
        error = document.getElementById("exhibition-error");
  const name = input.value.trim();
  if (!name) return;
  error.textContent = "";
  const button = document.getElementById("exhibition-create-button");
  button.disabled = true;
  try {
    const result = await filesAction("create_exhibition", {name});
    upsertItem(result.item);
    input.value = "";
    await refreshExhibitions({force: true});
  } catch (err) {
    error.textContent = err.message || "Could not create bucket.";
  } finally {
    button.disabled = exhibitionRecords.length >= 3;
  }
});
const addToggle = addWrap.querySelector("#add-toggle");
const addMenu = addWrap.querySelector("#add-menu");
addToggle.addEventListener("click", event => {
  event.stopPropagation();
  addMenu.hidden = !addMenu.hidden;
  addToggle.setAttribute("aria-expanded", String(!addMenu.hidden));
});
document.addEventListener("click", event => {
  if (!event.target.closest(".add-wrap")) {
    addMenu.hidden = true;
    addToggle.setAttribute("aria-expanded", "false");
  }
});
addMenu.addEventListener("click", event => {
  const button = event.target.closest("#upload-option,#upload-folder-option,#new-folder-option");
  if (!button) return;
  addMenu.hidden = true;
  addToggle.setAttribute("aria-expanded", "false");
  if (button.id === "new-folder-option") {
    createFolderPrompt();
    return;
  }
  document.getElementById(button.id === "upload-option" ? "file-picker" : "folder-picker").click();
});
async function createFolderPrompt() {
  const name = prompt("New folder name");
  if (!name || !name.trim()) return;
  try {
    const result =
        await filesAction("create_folder", {parentId: currentFolderId, name: name.trim()});
    upsertItem(result.item);
    renderItems();
  } catch (error) {
    alert(error.message);
  }
}
// Upload files and folders to Backblaze.
const retryableUploadStatuses = new Set([408, 429, 500, 502, 503, 504]);
function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requestedDelay =
        Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requestedDelay) && requestedDelay > 0)
      return Math.min(requestedDelay, 30000);
  }
  return Math.min(1000 * 2 ** (attempt - 1) + Math.random() * 250, 15000);
}
async function waitForUploadRetry(delay, signal) {
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, {once:true});
  });
}
async function uploadToBackblaze(uploadUrl, contentType, file, signal) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    let response;
    try {
      response = await fetch(uploadUrl, {
        method:"PUT",
        headers:{"Content-Type":contentType || "application/octet-stream"},
        body:file,
        signal,
        cache:"no-store",
        credentials:"omit",
        mode:"cors"
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      if (attempt === maxAttempts) {
        throw new Error(
          "Could not connect to Backblaze after " + maxAttempts +
          " attempts. Check this device's connection and browser settings. (" +
          (error?.message || error?.name || "Network error") + ")");
      }
      await waitForUploadRetry(Math.min(1000 * 2 ** (attempt - 1), 12000), signal);
      continue;
    }
    if (response.ok) return;
    if (!retryableUploadStatuses.has(response.status) || attempt === maxAttempts) {
      if (response.status === 503)
        throw new Error("Backblaze is temporarily unavailable (HTTP 503). Please retry shortly.");
      if (response.status === 429)
        throw new Error("Backblaze is rate-limiting this upload (HTTP 429). Please retry shortly.");
      if (response.status === 403)
        throw new Error(
          "Backblaze denied this upload (HTTP 403). The signed request or bucket permissions need attention.");
      throw new Error("Backblaze rejected this file (HTTP " + response.status + ").");
    }
    await waitForUploadRetry(retryDelay(response, attempt), signal);
  }
  throw new Error("Upload failed. Please retry.");
}
async function saveFile(file, parentId, name = file.name, signal) {
  const created = await filesAction(
      "create_upload", {parentId, name, contentType: file.type || "application/octet-stream"});
  try {
    await uploadToBackblaze(created.uploadUrl, created.contentType, file, signal);
    await filesAction("finish_upload", {id: created.item.id});
    upsertItem(created.item);
  } catch (error) {
    try {
      await filesAction("delete", {id: created.item.id});
    } catch {
    }
    throw error;
  }
}
let observedCompletedUploadIds = new Set();
window.addEventListener("coolanas-upload-updated", event => {
  const tasks = event.detail || [];
  const completedNow = tasks.filter(task => task.status === "complete");
  const newlyCompleted = completedNow.some(task => !observedCompletedUploadIds.has(task.id));
  observedCompletedUploadIds = new Set(completedNow.map(task => task.id));
  if (newlyCompleted) loadItems({force:true}).catch(
      error => console.warn("Could not refresh files after background upload:", error.message));
});
async function uploadEntries(entries, parentId = currentFolderId) {
  if (activeSharedBucket) {
    alert("Shared buckets are read-only.");
    return;
  }
  if (!entries.length) return;
  if (!window.CoolanasUploads?.enqueue) {
    alert("Background uploads are unavailable in this browser. Please reload and try again.");
    return;
  }
  clearSelection();
  uploadTitle.textContent = "Preparing uploads";
  activeUploadController = new AbortController();
  uploadMinimised = false;
  uploadCancelled = false;
  uploadMini.hidden = true;
  const signal = activeUploadController.signal;
  let skipped = 0;
  const folderIds = new Map();
  try {
    const prepared = [];
    const plannedFolderFiles = new Set();
    for (const entry of entries) {
      if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
      const displayName = entry.path || entry.file.name;
      const parts = displayName.split("/").filter(Boolean);
      if (!parts.length) continue;
      let parent = parentId;
      for (let index = 0; index < parts.length - 1; index++) {
        const key = (parent || "root") + ":" + parts.slice(0, index + 1).join("/");
        if (!folderIds.has(key)) {
          let folder = items.find(item => item.item_type === "folder" &&
              item.parent_id === parent && item.name === parts[index]);
          if (!folder) {
            const response = await filesAction("create_folder", {parentId:parent,name:parts[index]});
            folder = response.item;
            upsertItem(folder);
          }
          folderIds.set(key, folder.id);
        }
        parent = folderIds.get(key);
      }
      const fileName = parts[parts.length - 1];
      const isFolderImport = displayName.includes("/");
      const plannedKey = (parent || "root") + ":" + fileName;
      if (isFolderImport &&
          (items.some(item => item.item_type === "file" && item.parent_id === parent &&
              item.name === fileName) || plannedFolderFiles.has(plannedKey))) {
        skipped++;
        continue;
      }
      if (isFolderImport) plannedFolderFiles.add(plannedKey);
      prepared.push({file:entry.file,fileName,parentId:parent});
    }
    if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
    if (!prepared.length) {
      if (skipped) alert(skipped + " existing file(s) skipped.");
      return;
    }
    await window.CoolanasUploads.enqueue(
        prepared, {userId:user.id, accessToken:session.access_token});
    if (skipped) alert(skipped + " existing file(s) skipped. The remaining files were added to the background upload queue.");
    if (exhibitionRootId)
      refreshExhibitions().catch(error =>
          console.warn("Storage usage refresh failed:", error.message));
  } catch (error) {
    if (error?.name === "AbortError" || signal.aborted)
      alert("Upload preparation was cancelled. Files already queued will continue uploading.");
    else
      alert("Could not queue the files: " + (error?.message || error?.name || "Unknown upload error"));
  } finally {
    hideUploadProgress();
  }
}
const picker = document.getElementById("file-picker");
const folderPicker = document.getElementById("folder-picker");
picker.addEventListener("change", async () => {
  if (activeSharedBucket) {
    picker.value = "";
    alert("Shared buckets are read-only.");
    return;
  }
  const entries = [...picker.files].map(file => ({file, path: file.name}));
  await uploadEntries(entries, currentFolderId);
  picker.value = "";
});
folderPicker.addEventListener("change", async () => {
  if (activeSharedBucket) {
    folderPicker.value = "";
    alert("Shared buckets are read-only.");
    return;
  }
  const entries =
      [...folderPicker.files].map(file => ({file, path: file.webkitRelativePath || file.name}));
  await uploadEntries(entries, currentFolderId);
  folderPicker.value = "";
});
async function readDirectoryEntry(entry, path, output) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    output.push({file, path: path + entry.name});
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    while (true) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await readDirectoryEntry(child, path + entry.name + "/", output);
    }
  }
}
async function extractDroppedEntries(dataTransfer) {
  const output = [];
  const items = [...(dataTransfer.items || [])].filter(item => item.kind === "file");
  const entries = items.map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    for (const entry of entries) await readDirectoryEntry(entry, "", output);
  } else {
    for (const file of [...(dataTransfer.files || [])]) output.push({file, path: file.name});
  }
  return output;
}
async function handleExternalDrop(dataTransfer, targetParentId = currentFolderId) {
  if (activeSharedBucket) return;
  try {
    const entries = await extractDroppedEntries(dataTransfer);
    await uploadEntries(entries, targetParentId);
  } catch (error) {
    alert("Could not read the dropped files: " + error.message);
  }
}
document.addEventListener("dragenter", event => {
  if (internalDragIds.length) return;
  if (event.dataTransfer?.types?.includes("Files")) {
    externalDragDepth++;
    dropHint.hidden = false;
  }
});
document.addEventListener("dragover", event => {
  if (internalDragIds.length) return;
  if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
});
document.addEventListener("dragleave", event => {
  if (internalDragIds.length) return;
  if (event.dataTransfer?.types?.includes("Files")) {
    externalDragDepth = Math.max(0, externalDragDepth - 1);
    if (externalDragDepth === 0) dropHint.hidden = true;
  }
});
document.addEventListener("drop", async (event) => {
  if (internalDragIds.length) return;
  if (event.dataTransfer?.types?.includes("Files")) {
    event.preventDefault();
    externalDragDepth = 0;
    dropHint.hidden = true;
    if (event.target.closest(".file-card")) return;
    await handleExternalDrop(event.dataTransfer, currentFolderId);
  }
});
// Move, reorder, preview, and download items.
async function topLevelIds(ids) {
  const selected = new Set(ids);
  return ids.filter(id => {
    let parent = items.find(item => item.id === id)?.parent_id;
    while (parent) {
      if (selected.has(parent)) return false;
      parent = items.find(item => item.id === parent)?.parent_id || null;
    }
    return true;
  });
}
async function moveItems(ids, targetParentId) {
  const roots =
      (await topLevelIds(ids))
          .filter(id => items.find(entry => entry.id === id)?.parent_id !== targetParentId);
  if (!roots.length) return;
  const mutationId = crypto.randomUUID();
  const mutation = {
    id: mutationId,
    userId: user.id,
    type: "move",
    itemId: "move:" + mutationId,
    changes: {ids: roots, targetParentId: targetParentId ?? null, sortOrders: {}},
    createdAt: Date.now()
  };
  let nextSortOrder = Math.max(
      0,
      ...items.filter(item => item.parent_id === targetParentId)
          .map(item => Number(item.sort_order) || 0));
  for (const id of roots) mutation.changes.sortOrders[id] = nextSortOrder += 10;
  try {
    await savePendingMutation(mutation);
    const queuedIds = mutation.changes.ids;
    if (!queuedIds.length) return;
    for (const id of queuedIds) {
      const item = items.find(entry => entry.id === id);
      if (item) {
        item.parent_id = targetParentId ?? null;
        item.sort_order = mutation.changes.sortOrders[id];
      }
    }
    clearSelection();
    renderItems();
  } catch (error) {
    try {
      await filesAction("move", {ids: roots, targetParentId});
      for (const id of roots) {
        const item = items.find(entry => entry.id === id);
        if (item) {
          item.parent_id = targetParentId ?? null;
          item.sort_order = mutation.changes.sortOrders[id];
        }
      }
      clearSelection();
      renderItems();
    } catch (remoteError) {
      alert("Could not move the selected items. " + remoteError.message);
    }
  }
}
async function reorderBefore(ids, targetId) {
  const target = items.find(item => item.id === targetId);
  if (!target) return;
  const parentId = target.parent_id;
  const ordered = items.filter(item => item.parent_id === parentId)
                      .sort(
                          (a, b) => (Number(a.sort_order || 0) - Number(b.sort_order || 0)) ||
                              a.name.localeCompare(b.name));
  const moving = await topLevelIds(ids);
  if (!moving.length ||
      moving.some(id => items.find(item => item.id === id)?.parent_id !== parentId)) {
    return;
  }
  const remaining = ordered.filter(item => !moving.includes(item.id));
  const insertAt = remaining.findIndex(item => item.id === targetId);
  remaining.splice(
      Math.max(0, insertAt), 0,
      ...moving.map(id => items.find(item => item.id === id)).filter(Boolean));
  try {
    await filesAction("reorder", {ids: remaining.map(item => item.id), targetParentId: parentId});
    remaining.forEach((item, index) => {
      item.sort_order = (index + 1) * 10;
    });
    clearSelection();
    renderItems();
  } catch (error) {
    alert(error.message);
  }
}
async function openFile(item) {
  viewer.hidden = false;
  viewerTitle.textContent = item.name;
  viewerContent.textContent = "Loading preview…";
  const viewerDownload = document.getElementById("viewer-download");
  viewerDownload.hidden = true;
  viewerDownload.removeAttribute("href");
  const downloadAllowed = !activeSharedBucket || activeSharedBucket.permission !== "view";
  try {
    const result = await filesAction(downloadAllowed ? "download" : "file_preview", {id: item.id});
    const response = await fetch(result.downloadUrl);
    if (!response.ok) throw new Error("Backblaze download failed (" + response.status + ").");
    const data = await response.blob();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(data);
    if (downloadAllowed) {
      viewerDownload.href = objectUrl;
      viewerDownload.download = item.name;
      viewerDownload.hidden = false;
    }
    viewerContent.replaceChildren();
    if (data.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = objectUrl;
      viewerContent.append(img);
    } else if (data.type === "application/pdf") {
      const frame = document.createElement("iframe");
      frame.src = objectUrl;
      viewerContent.append(frame);
    } else if (
        data.type.startsWith("text/") ||
        /\.(txt|md|json|js|css|html|xml|csv|log)$/i.test(item.name)) {
      viewerContent.textContent = await data.text();
    } else {
      const message = document.createElement("p");
      message.textContent = "Preview is unavailable for this file type.";
      if (downloadAllowed) {
        const download = document.createElement("a");
        download.href = objectUrl;
        download.download = item.name;
        download.textContent = "Download file";
        viewerContent.replaceChildren(message, download);
      } else {
        viewerContent.replaceChildren(message);
      }
    }
  } catch (error) {
    viewerContent.textContent = error.message;
  }
}
function closeViewer() {
  viewer.hidden = true;
  viewerContent.replaceChildren();
  const viewerDownload = document.getElementById("viewer-download");
  viewerDownload.hidden = true;
  viewerDownload.removeAttribute("href");
  viewerDownload.removeAttribute("download");
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}
document.getElementById("viewer-close").addEventListener("click", closeViewer);
viewer.addEventListener("click", event => {
  if (event.target === viewer) closeViewer();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeNavPanels();
    closeBucketSharePanel();
    shareConfirmOverlay.hidden = true;
    clearSelection();
    closeCardSettings();
    closeDeleteConfirmation();
  }
});
// Paint the last known workspace immediately. Network checks happen silently
// in the background and only update the page when the data actually changes.
const startupCache = readWorkspaceCache();
const hasWorkspaceCache = Boolean(startupCache?.rootId);
if (hasWorkspaceCache) {
  exhibitionRootId = startupCache.rootId;
  currentFolderId = exhibitionRootId;
  items = Array.isArray(startupCache.items) ? startupCache.items : [];
  ownedItems = items;
  exhibitionRecords = Array.isArray(startupCache.exhibitions) ? startupCache.exhibitions : [];
  exhibitionTotalBytes = Number(startupCache.totalBytes) || 0;
  sharedBucketRecords = Array.isArray(startupCache.sharedBuckets) ? startupCache.sharedBuckets : [];
  sharedByYouRecords = Array.isArray(startupCache.sharedByYou) ? startupCache.sharedByYou : [];
  sharedFolderCache = startupCache.sharedFolderCache && typeof startupCache.sharedFolderCache === "object" ?
      startupCache.sharedFolderCache : {};
  workspaceCacheTimestamp = Number(startupCache.savedAt) || Date.now();
  metadataCacheTimestamp = Number(startupCache.metadataSavedAt) || 0;
  document.getElementById("bucket-title").textContent =
      "Bucket • " + formatStorage(exhibitionTotalBytes);
  document.getElementById("exhibition-create-form").hidden = exhibitionRecords.length >= 3;
  renderItems();
  void refreshSharedBuckets({cacheOnly: true, silent: true});
}
const migrationKey = "coolanas-prefix-migrated:" + user.id;
if (localStorage.getItem(migrationKey) !== "1") {
  try {
    await filesAction("migrate_prefix");
    localStorage.setItem(migrationKey, "1");
  } catch (error) {
    console.warn("Existing file prefix migration could not finish:", error.message);
  }
}
if (!exhibitionRootId) {
  try {
    const accountStructure = await filesAction("ensure_structure");
    exhibitionRootId = accountStructure?.exhibitionsId || null;
    currentFolderId = exhibitionRootId;
  } catch (error) {
    console.warn("Your account folders could not be prepared:", error.message);
  }
}
if (!hasWorkspaceCache) {
  await loadItems();
  if (exhibitionRootId) await refreshExhibitions({force: true});
}
flushPendingMutations();

async function checkForWorkspaceChanges() {
  if (document.visibilityState !== "visible" || !exhibitionRootId) return;
  try {
    if (activeSharedBucket) {
      const result = await filesAction("shared_bucket_open", {bucketId: activeSharedBucket.id});
      const nextItems = result.items || [];
      if (JSON.stringify(nextItems) !== JSON.stringify(items)) {
        items = nextItems;
        renderItems();
      }
      sharedFolderCache[activeSharedBucket.id] = {items: nextItems, savedAt: Date.now()};
    } else {
      const result = await filesAction("list");
      const nextItems = result.items || [];
      if (JSON.stringify(nextItems) !== JSON.stringify(ownedItems)) {
        ownedItems = nextItems;
        items = ownedItems;
        renderItems();
      }
      workspaceCacheTimestamp = Date.now();
    }
    await refreshExhibitions({force: true, silent: true});
    writeWorkspaceCache();
  } catch (error) {
    console.warn("Background bucket check failed:", error.message);
  }
}
setInterval(checkForWorkspaceChanges, 30000);
