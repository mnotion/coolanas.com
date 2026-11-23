const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
const {createClient} = await import("https://esm.sh/@supabase/supabase-js@2.119.0");
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    experimental: {passkey: true}
  }
});
// Google sign-in return and username setup.
const accountStatus = document.getElementById("account-status");
const usernameForm = document.getElementById("username-form");
const usernameInput = document.getElementById("username-input");
const usernameError = document.getElementById("username-error");
const usernameSubmit = document.getElementById("username-submit");
const callbackParams = new URLSearchParams(location.search);
const callbackCode = callbackParams.get("code");
const callbackError = callbackParams.get("error_description") || callbackParams.get("error");
const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
const isAuthCallback = Boolean(callbackCode || callbackError || hashParams.has("access_token"));
async function getCallbackSession() {
  if (callbackError) {
    throw new Error(callbackError);
  }
  if (callbackCode) {
    const {data, error} = await supabase.auth.exchangeCodeForSession(callbackCode);
    if (error) throw error;
    return data.session || null;
  }
  const accessToken = hashParams.get("access_token");
  const refreshToken = hashParams.get("refresh_token");
  if (accessToken && refreshToken) {
    const {data, error} =
        await supabase.auth.setSession({access_token: accessToken, refresh_token: refreshToken});
    if (error) throw error;
    return data.session || null;
  }
  const {data: {session}, error} = await supabase.auth.getSession();
  if (error) throw error;
  return session;
}
function validateUsername(value) {
  const length = [...value].length;
  if (length < 4 || length > 100) return "Username must be 4–100 characters.";
  if (/\s/u.test(value)) return "Spaces are not allowed.";
  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u20E3]/u.test(value))
    return "Emojis are not allowed.";
  return "";
}
async function requireUsername(session) {
  const {data: profile, error: profileError} =
      await supabase.from("profiles").select("username").eq("id", session.user.id).maybeSingle();

  if (profileError) throw profileError;
  if (profile?.username) {
    return;
  }
  accountStatus.textContent = "One more step: create your Coolanas username.";
  usernameForm.hidden = false;
  usernameForm.style.display = "block";
  usernameSubmit.disabled = false;
  usernameInput.focus();
  await new Promise((resolve) => {
    usernameForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const username = usernameInput.value;
      const validation = validateUsername(username);
      if (validation) {
        usernameError.textContent = validation;
        return;
      }
      usernameSubmit.disabled = true;
      usernameError.textContent = "Checking username…";
      try {
        const {error: updateError} =
            await supabase.from("profiles").update({username}).eq("id", session.user.id);
        if (updateError) {
          if (/duplicate key|profiles_username_lower_key|profiles_username_key/i.test(
                  updateError.message))
            throw new Error("That username is already taken.");
          throw updateError;
        }
        const {error: metadataError} = await supabase.auth.updateUser({data: {username}});
        if (metadataError)
          console.warn("Username profile saved; auth metadata sync failed:", metadataError.message);
        usernameError.textContent = "";
        resolve();
      } catch (error) {
        usernameError.textContent = error?.message || "Could not save username.";
        usernameSubmit.disabled = false;
      }
    });
  });
}
// Mail notifications and invitation responses.
const mailButton = document.getElementById("mail-button");
const mailPopover = document.getElementById("mail-popover");
mailButton.addEventListener("click", () => {
  const opening = mailPopover.hidden;
  mailPopover.hidden = !opening;
  mailButton.setAttribute("aria-expanded", String(opening));
  if (opening) refreshMail(true);
});
const mailNotifications = document.getElementById("mail-notifications");
const mailUnreadIndicator = document.getElementById("mail-unread-indicator");
function setMailUnreadIndicator(hasUnread) {
  mailUnreadIndicator.classList.toggle("visible", Boolean(hasUnread));
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
      if (markVisibleAsRead && !notification.read_at)
        markReadRequests.push(supabase.functions.invoke(
            "coolanas-files-b2",
            {body: {action: "mail_mark_read", notificationId: notification.id}}));

      mailNotifications.append(card);
    }
    if (markReadRequests.length) {
      await Promise.all(markReadRequests);
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
refreshMail();
setInterval(() => refreshMail(), 30000);
document.addEventListener("click", event => {
  if (!mailPopover.hidden && !mailPopover.contains(event.target) &&
      !mailButton.contains(event.target)) {
    mailPopover.hidden = true;
    mailButton.setAttribute("aria-expanded", "false");
  }
});
// Profile menu, account activity, and appearance.
const profileButton = document.getElementById("profile-button");
const profileDrawer = document.getElementById("profile-drawer");
const profileBackdrop = document.getElementById("profile-backdrop");
const profilePictureInput = document.getElementById("profile-picture-input");
const profileAvatar = document.getElementById("profile-avatar");
const drawerAvatar = document.getElementById("drawer-avatar");
const avatarFallback = document.getElementById("profile-avatar-fallback");
const drawerAvatarFallback = document.getElementById("drawer-avatar-fallback");
const removePfpButton = document.getElementById("remove-pfp");
const themeToggle = document.getElementById("theme-toggle");
function applyTheme(mode) {
  document.documentElement.classList.toggle("dark-mode", mode === "dark");
  themeToggle.textContent = mode === "dark" ? "Switch to light mode" : "Switch to dark mode";
  try {
    localStorage.setItem("coolanas-theme", mode);
  } catch {
  }
}
applyTheme(localStorage.getItem("coolanas-theme") === "dark" ? "dark" : "light");
themeToggle.addEventListener(
    "click",
    () => applyTheme(document.documentElement.classList.contains("dark-mode") ? "light" : "dark"));
window.addEventListener("storage", event => {
  if (event.key === "coolanas-theme") applyTheme(event.newValue === "dark" ? "dark" : "light");
});
let googleAvatarUrl = "";
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
        } else {
          img.hidden = true;
          avatarFallback.hidden = true;
          drawerAvatarFallback.hidden = true;
        }
      };
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
  }
  avatarFallback.hidden = Boolean(url);
  drawerAvatarFallback.hidden = Boolean(url);
  removePfpButton.hidden = !customProfilePicture;
}
let customProfilePicture = false;
async function profileAction(action, payload = {}) {
  const {data, error} =
      await withRequestTimeout(
          supabase.functions.invoke("coolanas-files-b2", {body: {action, ...payload}}),
          action.startsWith("subjects_") ? "Subject request" : action.startsWith("tasks_") ? "Task request" : "Profile request");
  if (error) throw new Error(error.message || "Profile picture request failed.");
  if (data?.error) throw new Error(data.error);
  return data;
}
async function refreshProfilePicture() {
  const result = await profileAction("profile_picture_get");
  customProfilePicture = Boolean(result.exists && result.url);
  setAvatar(customProfilePicture ? result.url : googleAvatarUrl);
}
function loadContributionGraph() {
  const grid = document.getElementById("contribution-grid");
  const today = new Date();
  const yearStart = new Date(2026, 0, 1);
  const yearEnd = new Date(2027, 0, 1);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const firstWeekday = (yearStart.getDay() + 6) % 7;
  grid.replaceChildren();
  let tooltip = document.getElementById("contribution-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "contribution-tooltip";
    tooltip.className = "contribution-tooltip";
    tooltip.setAttribute("role", "status");
    document.body.appendChild(tooltip);
  }
  const hideTooltip = () => tooltip.classList.remove("visible");
  function positionTooltip(event) {
    if (event.pointerType === "touch") return;
    const offset = 12;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const left = Math.min(window.innerWidth - width - 8, event.clientX + offset);
    const top = Math.max(8, event.clientY - height - offset);
    tooltip.style.left = Math.max(8, left) + "px";
    tooltip.style.top = top + "px";
  }
  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement("span");
    blank.className = "contribution-day empty";
    blank.setAttribute("aria-hidden", "true");
    grid.appendChild(blank);
  }
  for (let date = new Date(yearStart); date < yearEnd; date.setDate(date.getDate() + 1)) {
    const cell = document.createElement("span");
    cell.className = "contribution-day";
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (day < todayStart) cell.classList.add("passed");
    if (day.getTime() === todayStart.getTime()) cell.classList.add("today");
    const dateLabel =
        date.toLocaleDateString(undefined, {year: "numeric", month: "long", day: "numeric"});
    cell.setAttribute("aria-label", dateLabel + (day < todayStart ? ", passed" : ""));
    cell.addEventListener("pointerenter", event => {
      if (event.pointerType === "touch") return;
      tooltip.textContent = dateLabel;
      tooltip.classList.add("visible");
      positionTooltip(event);
    });
    cell.addEventListener("pointermove", positionTooltip);
    cell.addEventListener("pointerleave", hideTooltip);
    cell.addEventListener("focus", () => {
      tooltip.textContent = dateLabel;
      tooltip.classList.add("visible");
      const rect = cell.getBoundingClientRect();
      positionTooltip({clientX: rect.right, clientY: rect.top, pointerType: "mouse"});
    });
    cell.addEventListener("blur", hideTooltip);
    grid.appendChild(cell);
  }
}
// Personal task list and drag-to-reorder behavior.
const taskItemsEl = document.getElementById("task-items");
const taskAddForm = document.getElementById("task-add-form");
const taskAddInput = document.getElementById("task-add-input");
const taskError = document.getElementById("task-error");
let tasks = [];
let tasksReady = false;
let taskDragId = null;
let dropIndicator = null;
async function taskAction(action, payload = {}) {
  const {data, error} =
      await withRequestTimeout(
        supabase.functions.invoke("coolanas-files-b2", {body: {action, ...payload}}),
        action.startsWith("subjects_") ? "Subject request" : "Task request");
  if (error) throw new Error(error.message || "Could not save tasks.");
  if (data?.error) throw new Error(data.error);
  return data;
}
async function persistTasks() {
  taskError.textContent = "";
  try {
    await taskAction("tasks_save", {tasks});
  } catch (error) {
    taskError.textContent = error.message || "Tasks could not be saved.";
  }
}
function ensureDropIndicator() {
  if (!dropIndicator) {
    dropIndicator = document.createElement("div");
    dropIndicator.className = "task-drop-indicator";
    dropIndicator.setAttribute("aria-hidden", "true");
  }
  return dropIndicator;
}
function renderTasks() {
  taskItemsEl.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "task-empty";
    empty.textContent = "No tasks yet. Add one above.";
    taskItemsEl.appendChild(empty);
    return;
  }
  const todayKey = new Date().getFullYear() + "-" +
      String(new Date().getMonth() + 1).padStart(2, "0") + "-" +
      String(new Date().getDate()).padStart(2, "0");
  const visibleTasks = tasks.filter(task => !task.dueDate || task.dueDate <= todayKey);
  if (!visibleTasks.length) {
    const empty = document.createElement("div");
    empty.className = "task-empty";
    empty.textContent = tasks.length ? "No tasks scheduled for today yet." : "No tasks yet. Add one above.";
    taskItemsEl.appendChild(empty);
    return;
  }
  visibleTasks.forEach(task => {
    const row = document.createElement("div");
    row.className = "task-row" + (task.completed ? " completed" : "");
    row.dataset.taskId = task.id;
    const handle = document.createElement("span");
    handle.className = "task-drag-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder";
    handle.setAttribute("aria-label", "Drag to reorder");
    handle.draggable = true;
    const label = document.createElement("span");
    label.className = "task-text";
    label.textContent = task.text;
    const complete = document.createElement("label");
    complete.className = "container task-complete";
    complete.title = task.completed ? "Mark as incomplete" : "Mark as completed";
    const completeInput = document.createElement("input");
    completeInput.type = "checkbox";
    completeInput.checked = task.completed;
    completeInput.setAttribute("aria-label", complete.title);
    const completeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    completeSvg.setAttribute("viewBox", "0 0 64 64");
    completeSvg.setAttribute("height", "1.125em");
    completeSvg.setAttribute("width", "1.125em");
    const completePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    completePath.setAttribute(
        "d",
        "M 0 16 V 56 A 8 8 90 0 0 8 64 H 56 A 8 8 90 0 0 64 56 V 8 A 8 8 90 0 0 56 0 H 8 A 8 8 90 0 0 0 8 V 16 L 32 48 L 64 16 V 8 A 8 8 90 0 0 56 0 H 8 A 8 8 90 0 0 0 8 V 56 A 8 8 90 0 0 8 64 H 56 A 8 8 90 0 0 64 56 V 16");

    completePath.setAttribute("pathLength", "575.0541381835938");
    completePath.setAttribute("class", "path");
    completeSvg.appendChild(completePath);
    complete.append(completeInput, completeSvg);
    completeInput.addEventListener("change", async () => {
      const previous = task.completed;
      task.completed = completeInput.checked;
      if (task.completed) task.completedAt = new Date().getFullYear() + "-" +
          String(new Date().getMonth() + 1).padStart(2, "0") + "-" +
          String(new Date().getDate()).padStart(2, "0");
      else delete task.completedAt;
      row.classList.toggle("completed", task.completed);
      complete.title = task.completed ? "Mark as incomplete" : "Mark as completed";
      completeInput.setAttribute("aria-label", complete.title);
      taskError.textContent = "";
      await new Promise(resolve => setTimeout(resolve, 520));
      try {
        await taskAction("tasks_save", {tasks});
      } catch (error) {
        task.completed = previous;
        taskError.textContent = error.message || "Tasks could not be saved.";
        renderTasks();
      }
    });
    const remove = document.createElement("button");
    remove.className = "task-delete";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Delete " + task.text);
    remove.addEventListener("click", async () => {
      const previous = tasks.slice();
      tasks = tasks.filter(item => item.id !== task.id);
      renderTasks();
      await persistTasks();
      if (taskError.textContent) {
        tasks = previous;
        renderTasks();
      }
    });
    row.append(handle, label, complete, remove);
    label.addEventListener("dblclick", () => {
      if (row.classList.contains("editing")) return;
      row.classList.add("editing");
      label.hidden = true;
      handle.hidden = true;
      complete.hidden = true;
      remove.hidden = true;
      const input = document.createElement("input");
      input.className = "task-edit-input";
      input.type = "text";
      input.maxLength = 180;
      input.value = task.text;
      input.setAttribute("aria-label", "Edit task");
      row.insertBefore(input, remove);
      input.focus();
      input.select();
      let finished = false;
      const finish = async (save) => {
        if (finished) return;
        finished = true;
        const value = input.value.trim();
        if (save && value && value !== task.text) {
          const previous = tasks.slice();
          task.text = value;
          await persistTasks();
          if (taskError.textContent) tasks = previous;
        }
        renderTasks();
      };
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
    });
    handle.addEventListener("dragstart", event => {
      taskDragId = task.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
      ensureDropIndicator();
    });
    taskItemsEl.appendChild(row);
  });
}
function cleanupTaskDrag() {
  taskDragId = null;
  taskItemsEl.querySelectorAll(".task-row").forEach(el => el.classList.remove("dragging"));
  if (dropIndicator) {
    dropIndicator.classList.remove("visible");
    dropIndicator.remove();
  }
}
taskItemsEl.addEventListener("dragover", event => {
  if (!taskDragId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const row = event.target.closest?.(".task-row");
  const indicator = ensureDropIndicator();
  let anchor = null;
  if (row && row.dataset.taskId !== taskDragId) {
    const rect = row.getBoundingClientRect();
    anchor = event.clientY < rect.top + rect.height / 2 ? row : row.nextSibling;
  }
  if (anchor === row && row?.dataset.taskId === taskDragId) anchor = row.nextSibling;
  if (indicator.nextSibling !== anchor || indicator.parentNode !== taskItemsEl) {
    taskItemsEl.insertBefore(indicator, anchor);
  }
  indicator.classList.add("visible");
});
taskItemsEl.addEventListener("drop", async (event) => {
  if (!taskDragId) return;
  event.preventDefault();
  const sourceId = taskDragId;
  const indicator = ensureDropIndicator();
  const insertBefore = indicator.nextSibling;
  const previous = tasks.slice();
  const moved = tasks.find(item => item.id === sourceId);
  if (!moved) {
    cleanupTaskDrag();
    return;
  }
  const withoutSource = tasks.filter(item => item.id !== sourceId);
  let targetIndex = insertBefore?.dataset?.taskId ?
      withoutSource.findIndex(item => item.id === insertBefore.dataset.taskId) :
      withoutSource.length;

  if (targetIndex < 0) targetIndex = withoutSource.length;
  withoutSource.splice(targetIndex, 0, moved);
  const changed = withoutSource.some((item, index) => item.id !== tasks[index]?.id);
  tasks = withoutSource;
  cleanupTaskDrag();
  if (!changed) return;
  const oldRects = new Map([...taskItemsEl.querySelectorAll(".task-row")].map(
      row => [row.dataset.taskId, row.getBoundingClientRect()]));
  renderTasks();
  const newRows = [...taskItemsEl.querySelectorAll(".task-row")];
  newRows.forEach(row => {
    const before = oldRects.get(row.dataset.taskId);
    if (!before) return;
    const after = row.getBoundingClientRect();
    const delta = before.top - after.top;
    if (Math.abs(delta) < 1) return;
    row.style.transition = "none";
    row.style.transform = "translateY(" + delta + "px)";
    row.getBoundingClientRect();
    row.classList.add("task-settling");
    row.style.transform = "";
    row.addEventListener("transitionend", () => {
      row.classList.remove("task-settling");
      row.style.transition = "";
    }, {once: true});
  });
  await persistTasks();
  if (taskError.textContent) {
    tasks = previous;
    renderTasks();
  }
});
taskItemsEl.addEventListener("dragend", cleanupTaskDrag);
taskAddForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = taskAddInput.value.trim();
  if (!value || !tasksReady) return;
  if (tasks.length >= 100) {
    taskError.textContent = "You can have up to 100 tasks.";
    return;
  }
  const previous = tasks.slice();
  tasks.push({id: crypto.randomUUID(), text: value});
  taskAddInput.value = "";
  renderTasks();
  await persistTasks();
  if (taskError.textContent) {
    tasks = previous;
    renderTasks();
    taskAddInput.value = value;
  }
});
async function loadTasks() {
  try {
    const result = await taskAction("tasks_get");
    tasks = Array.isArray(result.tasks) ?
        result.tasks.map(task => ({...task, completed: task.completed === true})) :
        [];
    tasksReady = true;
    taskError.textContent = "";
    renderTasks();
  } catch (error) {
    taskItemsEl.textContent = "Tasks could not be loaded.";
    taskError.textContent = error.message || "Try refreshing the page.";
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && tasksReady) void loadTasks(); });
window.addEventListener("focus", () => { if (tasksReady) void loadTasks(); });
setInterval(() => { if (tasksReady) renderTasks(); }, 60000);
// Profile loading, picture updates, and sign-out.
async function initialiseProfile(session) {
  const meta = session.user.user_metadata || {};
  googleAvatarUrl = typeof meta.avatar_url === "string" ?
      meta.avatar_url :
      (typeof meta.picture === "string" ? meta.picture : "");
  const displayName =
      meta.full_name || meta.name || meta.user_name || session.user.email || "Account";
  document.getElementById("profile-name").textContent = displayName;
  document.getElementById("profile-email").textContent = session.user.email || "";
  loadContributionGraph();
  await loadTasks();
  avatarFallback.textContent = String(displayName).trim().charAt(0).toUpperCase() || "?";
  drawerAvatarFallback.textContent = avatarFallback.textContent;
  // Keep the Google avatar hidden until storage confirms whether a custom
  // Coolanas picture exists, preventing the wrong image from flashing.
  setAvatar("");
  try {
    await refreshProfilePicture();
  } catch (error) {
    console.warn("Could not load custom profile picture:", error.message);
    customProfilePicture = false;
    setAvatar(googleAvatarUrl);
  }
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
async function convertProfilePictureToPng(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose an image smaller than 20 MB.");
  if (!file.type.startsWith("image/") &&
      !/\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(file.name)) {
    throw new Error("Choose an image file.");
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, {imageOrientation: "from-image"});
  } catch {
    throw new Error(
        "This image format cannot be opened by this browser. Try converting it to a standard image first.");
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error("This image has invalid dimensions.");
    const sourceX = (bitmap.width - side) / 2;
    const sourceY = (bitmap.height - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d", {alpha: true});
    if (!context) throw new Error("Image conversion is unavailable in this browser.");
    context.drawImage(bitmap, sourceX, sourceY, side, side, 0, 0, 512, 512);
    const png = await new Promise(
        (resolve, reject) => canvas.toBlob(
            blob =>
                blob ? resolve(blob) : reject(new Error("Could not convert this image to PNG.")),
            "image/png"));

    if (png.size > 5 * 1024 * 1024)
      throw new Error("The converted PNG is larger than 5 MB. Choose a simpler image.");
    return png;
  } finally {
    bitmap.close?.();
  }
}
profilePictureInput.addEventListener("change", async () => {
  const file = profilePictureInput.files?.[0];
  profilePictureInput.value = "";
  if (!file) return;
  try {
    const png = await convertProfilePictureToPng(file);
    const signed = await profileAction("profile_picture_upload", {contentType: "image/png"});
    const response = await fetch(
        signed.uploadUrl, {method: "PUT", headers: {"Content-Type": "image/png"}, body: png});
    if (!response.ok) throw new Error("Image upload failed (HTTP " + response.status + ").");
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
document.getElementById("profile-signout").addEventListener("click", async () => {
  try {
    await leaveAccount();
  } catch (error) {
    alert(error.message);
  }
});
document.getElementById("change-account").addEventListener("click", async () => {
  try {
    await leaveAccount();
  } catch (error) {
    alert(error.message);
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeProfileDrawer();
});
function withRequestTimeout(promise, label, timeoutMs = 12000) {
  let timeoutId;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(label + " timed out. Please retry.")), timeoutMs);
    })
  ]).finally(() => clearTimeout(timeoutId));
}
let activeAccountId = null;
try {
  let session;
  if (isAuthCallback) {
    accountStatus.textContent = "Completing Google sign-in…";
    session = await getCallbackSession();
    if (!session) {
      throw new Error(
          "Google returned without an active Coolanas session. Return to sign-in and try again.");
    }
    history.replaceState(null, document.title, location.pathname);
    await requireUsername(session);
    void initialiseProfile(session);
  } else {
    const {data: {session: storedSession}, error} = await supabase.auth.getSession();
    if (error) throw error;
    session = storedSession;
    if (!session) {
      accountStatus.textContent = "You are not signed in. Return to sign in.";
    } else {
      await requireUsername(session);
      void initialiseProfile(session);
    }
  }
  activeAccountId = session?.user?.id || null;
} catch (authError) {
  accountStatus.textContent = "Google sign-in could not be completed.";
  accountStatus.textContent =
      authError?.message || "Authentication failed. Return to sign-in and try again.";
  console.error("Coolanas OAuth callback failed:", authError);
}
// Subjects are account-synced in stats/subjects.json.
(function setupSubjects() {
  const container = document.getElementById("study-subjects");
  const add = document.getElementById("study-subject-add");
  const input = document.getElementById("study-subject-input");
  const menu = document.getElementById("subject-context-menu");
  const colourRow = document.getElementById("subject-menu-colours");
  const activeLabel = document.getElementById("active-subject-label");
  const timerButton = document.getElementById("study-stopwatch-toggle");
  const hint = document.getElementById("subject-selection-hint");
  const palette = ["#e7e7e7", "#f6caca", "#f6dfaa", "#d9edbd", "#c9e7ef", "#d7d0f2", "#f0cce8"];
  const defaults = [
    "Maths", "English", "Biology", "Chemistry", "Physics", "History", "Geography",
    "Computer Science"
  ].map(name => ({name, color: 0}));

  const localKey = "coolanas-study-subjects-v1:" + activeAccountId;
  let subjects = defaults;
  let selected = null, activeIndex = -1, editingIndex = -1, saveQueue = Promise.resolve();
  window.coolanasSubjectState = {ready: false, selected: null};
  async function subjectAction(action, payload = {}) {
    const {data, error} =
        await withRequestTimeout(
        supabase.functions.invoke("coolanas-files-b2", {body: {action, ...payload}}),
        action.startsWith("subjects_") ? "Subject request" : "Task request");
    if (error) throw new Error(error.message || "Could not sync subjects.");
    if (data?.error) throw new Error(data.error);
    return data;
  }
  function normalize(list) {
    if (!Array.isArray(list)) return null;
    return list.filter(s => s && typeof s.name === "string" && s.name.trim())
        .slice(0, 40)
        .map(s => ({
               name: s.name.trim().slice(0, 32),
               color: Math.max(0, Math.min(6, Number(s.color) || 0))
             }));
  }
  function persist() {
    const snapshot = subjects.map(s => ({...s}));
    saveQueue =
        saveQueue.then(() => subjectAction("subjects_save", {subjects: snapshot})).catch(error => {
          console.error("Could not sync subjects:", error);
          hint.textContent = "Subjects could not sync. Changes will retry when you edit again.";
          hint.classList.add("visible");
        });
  }
  function render() {
    container.classList.remove("loading");
    container.querySelectorAll(".study-subject").forEach(el => el.remove());
    subjects.forEach((subject, index) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "study-subject";
      chip.textContent = subject.name;
      chip.dataset.index = String(index);
      chip.style.background = palette[subject.color];
      chip.style.borderColor = palette[subject.color];
      chip.style.color = "#444";
      chip.classList.toggle("selected", selected === index);
      chip.setAttribute("aria-pressed", String(selected === index));
      chip.title = "Click to select; double-click for options";
      container.insertBefore(chip, add);
    });
    const chosen = selected === null ? null : subjects[selected];
    window.coolanasSubjectState.selected = chosen ? chosen.name : null;
    if (chosen) {
      document.body.style.setProperty("--subject-colour", palette[chosen.color]);
      document.body.classList.add("subject-colour-preview");
    } else {
      document.body.classList.remove("subject-colour-preview");
      document.body.style.removeProperty("--subject-colour");
    }
    activeLabel.textContent = chosen ? chosen.name : "";
    activeLabel.style.background = chosen ? palette[chosen.color] : "#f7f7f7";
    activeLabel.style.borderColor = chosen ? palette[chosen.color] : "#dedede";
    activeLabel.style.color = "#555";
  }
  function closeMenu() {
    menu.hidden = true;
    colourRow.hidden = true;
  }
  function beginInlineEdit(index, isNew = false) {
    closeMenu();
    editingIndex = isNew ? -1 : index;
    const chip =
        isNew ? null : container.querySelector(".study-subject[data-index=\"" + index + "\"]");
    if (chip) chip.hidden = true;
    add.hidden = true;
    input.hidden = false;
    input.value = isNew ? "" : subjects[index].name;
    if (chip)
      chip.parentNode.insertBefore(input, chip);
    else
      container.insertBefore(input, add);
    input.focus();
    input.select();
  }
  function finishInlineEdit(save) {
    const value = input.value.trim();
    if (save && value) {
      const duplicate = subjects.some(
          (s, i) => i !== editingIndex && s.name.toLowerCase() === value.toLowerCase());
      if (!duplicate) {
        if (editingIndex < 0) {
          if (subjects.length < 40) subjects.push({name: value.slice(0, 32), color: 0});
        } else
          subjects[editingIndex].name = value.slice(0, 32);
        persist();
      }
    }
    input.hidden = true;
    add.hidden = false;
    render();
  }
  function openMenu(chip) {
    activeIndex = Number(chip.dataset.index);
    closeMenu();
    menu.hidden = false;
    const rect = chip.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(rect.left, window.innerWidth - 150)) + "px";
    menu.style.top = Math.max(6, Math.min(rect.bottom + 5, window.innerHeight - 80)) + "px";
    colourRow.replaceChildren();
    palette.forEach((color, i) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "subject-colour";
      swatch.style.background = color;
      swatch.setAttribute("aria-label", "Colour " + (i + 1));
      swatch.setAttribute("aria-pressed", String(subjects[activeIndex].color === i));
      swatch.addEventListener("click", () => {
        subjects[activeIndex].color = i;
        if (selected === activeIndex) document.body.style.setProperty("--subject-colour", color);
        persist();
        render();
        closeMenu();
      });
      colourRow.appendChild(swatch);
    });
  }
  add.addEventListener("click", () => beginInlineEdit(-1, true));
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      finishInlineEdit(true);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finishInlineEdit(false);
    }
  });
  input.addEventListener("blur", () => finishInlineEdit(true));
  container.addEventListener("click", event => {
    const chip = event.target.closest(".study-subject");
    if (!chip) return;
    selected = Number(chip.dataset.index);
    window.coolanasSubjectState.selected = subjects[selected]?.name || null;
    const selectedColour = palette[subjects[selected]?.color ?? 0];
    document.body.style.setProperty("--subject-colour", selectedColour);
    document.body.classList.add("subject-colour-preview");
    activeLabel.textContent = subjects[selected]?.name || "";
    activeLabel.style.background =
        subjects[selected] ? palette[subjects[selected].color] : "#f7f7f7";
    activeLabel.style.borderColor =
        subjects[selected] ? palette[subjects[selected].color] : "#dedede";
    activeLabel.style.color = "#555";
    document.body.classList.remove("subject-pick-mode");
    hint.textContent = "";
    hint.classList.remove("visible");
    container.querySelectorAll(".study-subject").forEach((item, index) => {
      item.classList.toggle("selected", index === selected);
      item.setAttribute("aria-pressed", String(index === selected));
    });
  });
  container.addEventListener("dblclick", event => {
    const chip = event.target.closest(".study-subject");
    if (chip) openMenu(chip);
  });
  menu.addEventListener("click", event => {
    const action = event.target.closest("button")?.dataset.action;
    if (action === "rename") beginInlineEdit(activeIndex);
    if (action === "colour") colourRow.hidden = !colourRow.hidden;
    if (action === "delete") {
      subjects.splice(activeIndex, 1);
      if (selected === activeIndex)
        selected = null;
      else if (selected !== null && selected > activeIndex)
        selected--;
      persist();
      render();
      closeMenu();
    }
  });
  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !menu.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeMenu();
  });
  (async () => {
    try {
      const result = await subjectAction("subjects_get");
      const cloud = normalize(result.subjects);
      if (cloud) {
        subjects = cloud;
      } else {
        try {
          const local = normalize(JSON.parse(localStorage.getItem(localKey) || "null"));
          if (local) subjects = local;
        } catch {
        }
        await subjectAction("subjects_save", {subjects});
      }
      localStorage.removeItem(localKey);
      selected = null;
      render();
      window.coolanasSubjectState.ready = true;
      timerButton.disabled = false;
      timerButton.title = "Start";
    } catch (error) {
      console.error("Could not load subjects:", error);
      hint.textContent = "Could not load your subjects. Refresh to retry.";
      hint.classList.add("visible");
      container.classList.remove("loading");
      container.replaceChildren();
      const failed = document.createElement("span");
      failed.className = "subject-load-error";
      failed.textContent = "Subjects unavailable";
      container.appendChild(failed);
      timerButton.disabled = true;
      timerButton.title = "Subjects unavailable";
    }
  })();
  container.classList.add("loading");
})();

// Lightweight YPT-style stopwatch. Elapsed time is persisted locally and
// recalculated from timestamps, so it remains accurate when the tab sleeps.
(function setupStudyStopwatch() {
  if (!activeAccountId) return;
  const accountKey = key => key + ":" + activeAccountId;
  // Never upload legacy unscoped records: their owner cannot be verified.
  localStorage.removeItem("coolanas-study-pending-analytics-v1");
  const timeEl = document.getElementById("study-stopwatch-time");
  const toggleButton = document.getElementById("study-stopwatch-toggle");
  const resetButton = document.getElementById("study-stopwatch-reset");
  const storageKey = accountKey("coolanas-study-stopwatch-v1");
  let state = {elapsed: 0, startedAt: null}, restoredCloudCheckpointAt = null;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (saved && typeof saved.elapsed === "number") {
      state = {
        elapsed: Math.max(0, saved.elapsed),
        startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt : null
      };
      restoredCloudCheckpointAt =
          Number.isFinite(saved.cloudCheckpointAt) ? saved.cloudCheckpointAt : null;
    }
  } catch (error) {
    console.warn("Could not restore stopwatch:", error);
  }
  let cloudCheckpointAt = restoredCloudCheckpointAt ?? state.startedAt;
  const monthlyKey = accountKey("coolanas-study-monthly-time-v1");
  function readMonthly() {
    try {
      const value = JSON.parse(localStorage.getItem(monthlyKey) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  function monthKey(timestamp) {
    const date = new Date(timestamp);
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }
  const dailyKey = accountKey("coolanas-study-daily-time-v1"),
        pendingKey = accountKey("coolanas-study-pending-analytics-v1");
  function readDaily() {
    try {
      const value = JSON.parse(localStorage.getItem(dailyKey) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  function savePending(records) {
    try {
      localStorage.setItem(pendingKey, JSON.stringify(records));
    } catch (error) {
      console.warn("Could not queue study-time sync:", error);
    }
  }
  function queueInterval(start, end, eventPrefix = "session") {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const pending = (() => {
      try {
        return JSON.parse(localStorage.getItem(pendingKey) || "[]");
      } catch {
        return [];
      }
    })();
// Reload if the authenticated account changes in this tab.
supabase.auth.onAuthStateChange((_event, nextSession) => {
  if ((nextSession?.user?.id || null) !== activeAccountId) location.reload();
});
// Dashboard navigation panels.
const navSearch = document.getElementById("search-toggle");
const navAnalytics = document.getElementById("analytics-toggle");
const searchPanel = document.getElementById("search-panel");
const analyticsPanel = document.getElementById("analytics-panel");
function closeNavPanels() {
  searchPanel.hidden = true;
  analyticsPanel.hidden = true;
  navSearch.setAttribute("aria-expanded", "false");
  navAnalytics.setAttribute("aria-expanded", "false");
}
function toggleNavPanel(panel, button) {
  const shouldOpen = panel.hidden;
  closeNavPanels();
  if (shouldOpen) {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    panel.querySelector("input")?.focus();
  }
}
document.querySelectorAll(".panel [data-close]")
    .forEach(button => button.addEventListener("click", closeNavPanels));
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeNavPanels();
});
