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

const registerButton = document.getElementById("register-button");
const statusLine = document.getElementById("status");

function setStatus(message, kind = "") {
  statusLine.textContent = message;
  statusLine.dataset.kind = kind;
}

async function initialise() {
  if (sessionStorage.getItem("coolanas-pin-unlocked") !== "1") {
    location.replace("index.html");
    return;
  }

  if (!window.isSecureContext || !("PublicKeyCredential" in window)) {
    registerButton.disabled = true;
    setStatus("Passkeys require HTTPS and a browser with WebAuthn support.", "error");
    return;
  }

  const { data, error } = await supabase.auth.getUser();
  if (error || data?.user?.id !== OWNER_USER_ID) {
    await supabase.auth.signOut();
    sessionStorage.removeItem("coolanas-pin-unlocked");
    location.replace("index.html");
    return;
  }

  const { data: credentials, error: listError } = await supabase.auth.passkey.list();
  if (listError) {
    registerButton.disabled = true;
    setStatus("Could not check the passkey status. " + listError.message, "error");
    return;
  }

  if (Array.isArray(credentials) && credentials.length > 0) {
    registerButton.hidden = true;
    setStatus("A passkey is already registered. The one-time registration is closed.", "success");
    return;
  }

  setStatus("PIN verified. Select the button to register your device passkey.");
  registerButton.disabled = false;
}

registerButton.addEventListener("click", async () => {
  registerButton.disabled = true;
  setStatus("Waiting for your device's passkey prompt…");

  try {
    const { data, error } = await supabase.auth.registerPasskey();
    if (error) {
      setStatus(error.message || "Passkey registration failed.", "error");
      registerButton.disabled = false;
      return;
    }

    setStatus("Passkey successfully registered with Supabase. The one-time registration is now closed.", "success");
    registerButton.hidden = true;
    sessionStorage.removeItem("coolanas-pin-unlocked");
    await supabase.auth.signOut();
  } catch {
    setStatus("Registration was cancelled or could not be completed. The registration slot remains available.", "error");
    registerButton.disabled = false;
  }
});

initialise();
