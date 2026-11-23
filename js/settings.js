// Account settings, status messages, and theme.
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

const $ = id => document.getElementById(id);
function setStatus(id, message, type = "") {
  const el = $(id);
  el.textContent = message;
  el.className = "status" + (type ? " " + type : "");
}
function applyTheme(mode) {
  window.CoolanasTheme?.apply(mode);
  document.documentElement.classList.toggle("dark-mode", mode === "dark");
  document.documentElement.dataset.theme = mode;
  $("theme-switch").setAttribute("aria-checked", String(mode === "dark"));
  $("theme-label").textContent = mode === "dark" ? "On" : "Off";
}
applyTheme(window.CoolanasTheme?.get() || "light");
window.addEventListener("coolanas:themechange", event => applyTheme(event.detail?.mode || "light"));
$("theme-switch").addEventListener("click", () => {
  const next = document.documentElement.classList.contains("dark-mode") ? "light" : "dark";
  window.CoolanasTheme?.set(next);
  applyTheme(next);
});
window.addEventListener("storage", event => {
  if (event.key === "coolanas-theme") applyTheme(event.newValue === "dark" ? "dark" : "light");
});
for (const button of document.querySelectorAll(".topic"))
  button.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".topic")) {
      const active = b === button;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    }
    for (const section of document.querySelectorAll(".section"))
      section.classList.toggle("active", section.id === "section-" + button.dataset.section);
  });
// Username and profile-picture actions.
async function profileAction(action, payload = {}) {
  const {data, error} =
      await supabase.functions.invoke("coolanas-files-b2", {body: {action, ...payload}});
  if (error) throw new Error(error.message || "Profile request failed.");
  if (data?.error) throw new Error(data.error);
  return data;
}
let user = null, googleAvatar = "", hasCustomPicture = false;
function showPicture(url) {
  const img = $("profile-picture"), fallback = $("picture-fallback");
  if (url) {
    img.src = url;
    img.hidden = false;
    fallback.hidden = true;
    img.onerror = () => {
      img.hidden = true;
      fallback.hidden = false;
    };
  } else {
    img.removeAttribute("src");
    img.hidden = true;
    fallback.hidden = false;
  }
  $("remove-picture-row").hidden = !hasCustomPicture;
}
async function refreshPicture() {
  const result = await profileAction("profile_picture_get");
  hasCustomPicture = Boolean(result.exists && result.url);
  showPicture(hasCustomPicture ? result.url : googleAvatar);
}
async function convertPicture(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose an image smaller than 20 MB.");
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
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
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
        bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 512, 512);
    const blob = await new Promise(
        (resolve, reject) => canvas.toBlob(
            v => v ? resolve(v) : reject(new Error("Could not convert image.")), "image/png"));

    if (blob.size > 5 * 1024 * 1024) throw new Error("The converted image is larger than 5 MB.");
    return blob;
  } finally {
    bitmap.close?.();
  }
}
$("change-picture").addEventListener("click", () => $("picture-input").click());
$("picture-input").addEventListener("change", async () => {
  const file = $("picture-input").files?.[0];
  $("picture-input").value = "";
  if (!file) return;
  const button = $("change-picture");
  button.disabled = true;
  try {
    const png = await convertPicture(file);
    const signed = await profileAction("profile_picture_upload", {contentType: "image/png"});
    const response = await fetch(
        signed.uploadUrl, {method: "PUT", headers: {"Content-Type": "image/png"}, body: png});
    if (!response.ok) throw new Error("Image upload failed (HTTP " + response.status + ").");
    await refreshPicture();
    setStatus("account-status", "Profile picture updated.", "success");
  } catch (error) {
    setStatus("account-status", error.message || "Could not update profile picture.", "error");
  } finally {
    button.disabled = false;
  }
});
$("remove-picture").addEventListener("click", async () => {
  const button = $("remove-picture");
  button.disabled = true;
  try {
    await profileAction("profile_picture_delete");
    hasCustomPicture = false;
    showPicture(googleAvatar);
    setStatus("account-status", "Profile picture removed.", "success");
  } catch (error) {
    setStatus("account-status", error.message || "Could not remove profile picture.", "error");
  } finally {
    button.disabled = false;
  }
});
$("username-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = $("username").value;
  const length = Array.from(value).length;
  if (length < 4 || length > 100 || /\s/u.test(value) ||
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u20E3]/u.test(value)) {
    setStatus("username-status", "Use 4–100 characters, with no spaces or emojis.", "error");
    return;
  }
  const button = $("save-username");
  button.disabled = true;
  setStatus("username-status", "Saving username…");
  try {
    const result = await profileAction("username_update", {username: value});
    $("username").value = result.username;
    setStatus("username-status", "Username updated.", "success");
  } catch (error) {
    const message = error.message || "Could not update username.";
    setStatus(
        "username-status",
        /duplicate|unique/i.test(message) ? "That username is already taken." : message, "error");
  } finally {
    button.disabled = false;
  }
});
const {data: {session}, error: sessionError} = await supabase.auth.getSession();
if (sessionError || !session?.user) {
  location.replace("/index.html");
  throw new Error("Sign in required.");
}
await window.CoolanasTheme?.loadForSession(session);
user = session.user;
googleAvatar = user.user_metadata?.avatar_url || user.user_metadata?.picture || "";
const {data: profile, error: profileError} =
    await supabase.from("profiles").select("username").eq("id", user.id).maybeSingle();
if (profileError) {
  setStatus("username-status", "Could not load your profile.", "error");
} else
  $("username").value = profile?.username || "";
try {
  await refreshPicture();
} catch (error) {
  setStatus("account-status", error.message || "Could not load profile picture.", "error");
}
