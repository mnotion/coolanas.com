// Temporary one-time passkey registration flow for mnotion.
// This file is intentionally separate so the enrollment UI can be removed after setup.
// The database trigger independently enforces the owner-only, one-registration limit.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.119.0";

const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
const OWNER_USER_ID = "bfc1c21b-11a1-4020-9a2f-2846dd4069bf";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

const signinPanel = document.getElementById("signin-panel");
const registerPanel = document.getElementById("register-panel");
const signinForm = document.getElementById("owner-signin");
const emailField = document.getElementById("email");
const passwordField = document.getElementById("password");
const signinButton = document.getElementById("signin-button");
const registerButton = document.getElementById("register-button");
const signoutButton = document.getElementById("signout-button");
const statusLine = document.getElementById("status");

function setStatus(message, kind = "") {
  statusLine.textContent = message;
  statusLine.dataset.kind = kind;
}

function showSignedOut() {
  signinPanel.hidden = false;
  registerPanel.hidden = true;
}

function showOwnerPanel() {
  signinPanel.hidden = true;
  registerPanel.hidden = false;
}

function readableAuthError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("passkey_disabled")) {
    return "Passkey authentication is not enabled in this Supabase project yet. The project owner must enable Authentication → Passkeys and configure the relying-party domain before registration.";
  }
  if (message.includes("too_many_passkeys") || message.includes("one-time passkey registration has already been used")) {
    return "The one-time registration has already been used. No further passkeys can be registered.";
  }
  if (message.includes("not allowed") || message.includes("restricted to the designated owner")) {
    return "This account is not authorised to register a passkey.";
  }
  return "The request could not be completed. Check the account details and try again.";
}

async function refreshRegistrationState() {
  const { data, error } = await supabase.auth.passkey.list();
  if (error) {
    registerButton.disabled = true;
    setStatus("Could not check passkey registration status. " + readableAuthError(error), "error");
    return;
  }

  if (Array.isArray(data) && data.length > 0) {
    registerButton.hidden = true;
    setStatus("A passkey is already registered for this account. Registration is closed.", "success");
  } else {
    registerButton.hidden = false;
    registerButton.disabled = false;
    setStatus("No passkey is registered yet. You can use the one-time registration now.");
  }
}

async function requireOwnerSession() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    showSignedOut();
    return false;
  }

  if (data.user.id !== OWNER_USER_ID) {
    await supabase.auth.signOut();
    showSignedOut();
    setStatus("This Supabase account is not authorised for mnotion passkey registration.", "error");
    return false;
  }

  showOwnerPanel();
  await refreshRegistrationState();
  return true;
}

signinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("");
  signinButton.disabled = true;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: emailField.value.trim(),
      password: passwordField.value
    });

    passwordField.value = "";

    if (error || !data?.user) {
      setStatus("Sign-in failed. Check your Supabase account details.", "error");
      return;
    }

    if (data.user.id !== OWNER_USER_ID) {
      await supabase.auth.signOut();
      setStatus("This Supabase account is not authorised for mnotion passkey registration.", "error");
      return;
    }

    await requireOwnerSession();
  } catch {
    passwordField.value = "";
    setStatus("Sign-in could not be completed. Try again.", "error");
  } finally {
    signinButton.disabled = false;
  }
});

registerButton.addEventListener("click", async () => {
  registerButton.disabled = true;
  setStatus("Waiting for your device to complete passkey registration…");

  try {
    if (!window.isSecureContext || !("PublicKeyCredential" in window)) {
      setStatus("This browser or connection does not support passkeys. Open the site over HTTPS in a supported browser.", "error");
      registerButton.disabled = false;
      return;
    }

    const ownerOk = await requireOwnerSession();
    if (!ownerOk) return;

    const { data, error } = await supabase.auth.registerPasskey();
    if (error) {
      setStatus(readableAuthError(error), "error");
      registerButton.disabled = false;
      return;
    }

    registerButton.hidden = true;
    setStatus("Passkey registered successfully. This account's one-time registration is now permanently closed.", "success");
    await supabase.auth.signOut();
    signinPanel.hidden = true;
    registerPanel.hidden = true;
    signoutButton.hidden = true;
    statusLine.textContent = "Passkey registered successfully. You have been signed out. The one-time registration is permanently closed.";
    statusLine.dataset.kind = "success";
  } catch {
    setStatus("Passkey registration was cancelled or could not be completed. The one-time slot remains available unless registration succeeded.", "error");
    registerButton.disabled = false;
  }
});

signoutButton.addEventListener("click", async () => {
  await supabase.auth.signOut();
  showSignedOut();
  setStatus("Signed out.");
});

(async function initialise() {
  if (!window.isSecureContext || !("PublicKeyCredential" in window)) {
    setStatus("Passkeys require HTTPS and a browser with WebAuthn support.", "error");
  }

  const { data } = await supabase.auth.getSession();
  if (data?.session) {
    await requireOwnerSession();
  } else {
    showSignedOut();
  }
})();
