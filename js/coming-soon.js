// Signed-in user directory and workspace placeholder.
const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
const {createClient} = await import("https://esm.sh/@supabase/supabase-js@2.119.0");
const supabase = createClient(
    SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
    {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}});

const {data: {session}, error: sessionError} = await supabase.auth.getSession();
if (sessionError || !session) {
  location.replace("/index.html");
  throw new Error("Sign-in required");
}
const user = session.user;
const {data: profile} =
    await supabase.from("profiles").select("username").eq("id", user.id).maybeSingle();
const displayName = profile?.username || user.user_metadata?.full_name || user.email || "Account";
document.getElementById("profile-name").textContent = displayName;
document.getElementById("profile-email").textContent = user.email || "";
const userList = document.getElementById("user-list");
try {
  const {data, error} = await supabase.functions.invoke(
      "coolanas-files-b2", {body: {action: "profile_picture_directory"}});
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  userList.replaceChildren();
  const users = data?.users || [];
  if (!users.length) {
    const li = document.createElement("li");
    li.className = "user-empty";
    li.textContent = "No signed-up users yet.";
    userList.append(li);
  }
  for (const userEntry of users) {
    const li = document.createElement("li");
    if (!userEntry.username) li.classList.add("user-avatar-only");
    const avatar = userEntry.pictureUrl || userEntry.googleAvatar || "";
    if (avatar) {
      const img = document.createElement("img");
      img.className = "user-avatar";
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.src = avatar;
      img.onerror = () => {
        img.remove();
      };
      li.append(img);
    }
    if (userEntry.username) {
      const name = document.createElement("span");
      name.className = "user-name";
      name.textContent = userEntry.username;
      li.append(name);
    }
    userList.append(li);
  }
} catch (error) {
  userList.replaceChildren();
  const li = document.createElement("li");
  li.className = "user-empty";
  li.textContent = "Could not load users.";
  userList.append(li);
  document.getElementById("user-error").textContent = error.message || "";
}
// Mail notifications.
const mailButton = document.getElementById("mail-button");
const mailPopover = document.getElementById("mail-popover");
const mailNotifications = document.getElementById("mail-notifications");
async function refreshMail() {
  try {
    const {data, error} =
        await supabase.functions.invoke("coolanas-files-b2", {body: {action: "mail_list"}});
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    const notifications = data?.notifications || [];
    mailNotifications.replaceChildren();
    if (!notifications.length) {
      const empty = document.createElement("p");
      empty.className = "mail-empty";
      empty.textContent = "No new mails.";
      mailNotifications.append(empty);
      return;
    }
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
      if (!notification.read_at) {
        supabase.functions
            .invoke(
                "coolanas-files-b2",
                {body: {action: "mail_mark_read", notificationId: notification.id}})
            .catch(() => {});
      }
      mailNotifications.append(card);
    }
  } catch (error) {
    mailNotifications.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "mail-empty";
    empty.textContent = error.message || "Could not load mail.";
    mailNotifications.append(empty);
  }
}
mailButton.addEventListener("click", () => {
  const opening = mailPopover.hidden;
  mailPopover.hidden = !opening;
  mailButton.setAttribute("aria-expanded", String(opening));
  if (opening) refreshMail();
});
document.addEventListener("click", event => {
  if (!mailPopover.hidden && !mailPopover.contains(event.target) &&
      !mailButton.contains(event.target)) {
    mailPopover.hidden = true;
    mailButton.setAttribute("aria-expanded", "false");
  }
});
// Profile menu, picture, and theme.
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
let googleAvatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture || "";
let customProfilePicture = false;
function setAvatar(url) {
  for (const img of [profileAvatar, drawerAvatar]) {
    img.onerror = null;
    if (url) {
      img.src = url;
      img.hidden = false;
      img.onerror = () => {
        img.onerror = null;
        img.hidden = true;
      };
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
  }
  avatarFallback.hidden = Boolean(url);
  drawerAvatarFallback.hidden = Boolean(url);
  avatarFallback.textContent = String(displayName).trim().charAt(0).toUpperCase() || "?";
  drawerAvatarFallback.textContent = avatarFallback.textContent;
  removePfpButton.hidden = !customProfilePicture;
}
async function profileAction(action, payload = {}) {
  const {data, error} =
      await supabase.functions.invoke("coolanas-files-b2", {body: {action, ...payload}});
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
document.getElementById("profile-settings")
    .addEventListener("click", () => location.assign("/settings.html"));
document.getElementById("profile-close").addEventListener("click", closeProfileDrawer);
profileBackdrop.addEventListener("click", closeProfileDrawer);
document.getElementById("change-pfp").addEventListener("click", () => profilePictureInput.click());
async function convertProfilePictureToPng(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose an image smaller than 20 MB.");
  if (!file.type.startsWith("image/") &&
      !/\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(file.name))
    throw new Error("Choose an image file.");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, {imageOrientation: "from-image"});
  } catch {
    throw new Error("This image format cannot be opened by this browser.");
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error("This image has invalid dimensions.");
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d", {alpha: true});
    if (!ctx) throw new Error("Image conversion is unavailable.");
    ctx.drawImage(
        bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 512, 512);
    return await new Promise(
        (resolve, reject) => canvas.toBlob(
            blob => blob ? resolve(blob) : reject(new Error("Could not convert image.")),
            "image/png"));

  } finally {
    bitmap.close?.();
  }
}
profilePictureInput.addEventListener("change", async () => {
  const file = profilePictureInput.files?.[0];
  profilePictureInput.value = "";
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("Choose an image smaller than 20 MB.");
    const isGif = file.type === "image/gif" || /\.gif$/i.test(file.name);
    const contentType = isGif ? "image/gif" : "image/png";
    const uploadBody = isGif ? file : await convertProfilePictureToPng(file);
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
setAvatar(googleAvatarUrl);
try {
  await refreshProfilePicture();
} catch (error) {
  console.warn("Could not load profile picture:", error.message);
}
