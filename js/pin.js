import { createClient } from "https://esm.sh/@supabase/supabase-js@2.119.0";

const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
const OWNER_USER_ID = "bfc1c21b-11a1-4020-9a2f-2846dd4069bf";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    experimental: { passkey: true }
  }
});

const passkeyButton = document.getElementById("passkey-login");
const passkeyStatus = document.getElementById("passkey-status");
const showPinButton = document.getElementById("show-pin");
const pinForm = document.getElementById("pin-form");
const pinField = document.getElementById("pin");
const pinError = document.getElementById("pin-error");
const pinSubmit = document.getElementById("pin-submit");

function setStatus(node, message, kind = "") {
  node.textContent = message;
  node.dataset.kind = kind;
}

showPinButton.addEventListener("click", () => {
  pinForm.hidden = !pinForm.hidden;
  showPinButton.textContent = pinForm.hidden ? "Use PIN instead" : "Hide PIN login";
  if (!pinForm.hidden) pinField.focus();
});

passkeyButton.addEventListener("click", async () => {
  passkeyButton.disabled = true;
  setStatus(passkeyStatus, "Waiting for your device's passkey prompt…");
  try {
    const { data, error } = await supabase.auth.signInWithPasskey();
    if (error) {
      setStatus(passkeyStatus, error.message || "Passkey sign-in failed.", "error");
      return;
    }
    if (data.user?.id !== OWNER_USER_ID) {
      await supabase.auth.signOut();
      setStatus(passkeyStatus, "This passkey is not authorised for this site.", "error");
      return;
    }
    sessionStorage.setItem("coolanas-pin-unlocked", "1");
    location.replace("dashboard.html");
  } catch (error) {
    setStatus(passkeyStatus, error?.message || "Passkey sign-in was cancelled or failed.", "error");
  } finally {
    passkeyButton.disabled = false;
  }
});

pinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus(pinError, "");
  const pin = pinField.value.trim().toUpperCase();
  if (!pin) return;

  pinSubmit.disabled = true;
  pinSubmit.textContent = "Checking…";
  try {
    const { data, error } = await supabase.functions.invoke(
      "coolanas-pin-passkey-session",
      { body: { pin } }
    );
    if (error || !data?.sent) {
      setStatus(pinError, data?.error || error?.message || "Could not verify the PIN.", "error");
      return;
    }
    pinField.value = "";
    setStatus(pinError, "PIN accepted. Check your email for the one-time sign-in link.", "success");
    pinSubmit.textContent = "Email sent";
  } catch {
    setStatus(pinError, "Connection failed. Try again.", "error");
  } finally {
    if (pinSubmit.textContent !== "Email sent") {
      pinSubmit.disabled = false;
      pinSubmit.textContent = "Continue with PIN";
    }
  }
});
