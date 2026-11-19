import { createClient } from "https://esm.sh/@supabase/supabase-js@2.119.0";

const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    experimental: { passkey: true }
  }
});

const form = document.getElementById("pin-form");
const field = document.getElementById("pin");
const error = document.getElementById("pin-error");
const card = document.querySelector(".pin-card");
const submitButton = form.querySelector('button[type="submit"]');
let feedbackTimer;

function showWrongPin() {
  document.body.classList.remove("wrong-pin");
  card.classList.remove("wrong-pin");
  void document.body.offsetWidth;
  document.body.classList.add("wrong-pin");
  card.classList.add("wrong-pin");
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    document.body.classList.remove("wrong-pin");
    card.classList.remove("wrong-pin");
  }, 700);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  const pin = field.value.trim().toUpperCase();
  if (!pin) return;

  submitButton.disabled = true;
  submitButton.textContent = "Checking…";

  try {
    const { data, error: functionError } = await supabase.functions.invoke(
      "coolanas-pin-passkey-session",
      { body: { pin } }
    );

    if (functionError || !data?.sent) {
      const message = data?.error || functionError?.message || "Could not verify the PIN.";
      error.textContent = message;
      if (functionError?.context?.status === 401 || message === "Incorrect PIN.") {
        field.value = "";
        showWrongPin();
      }
      return;
    }

    field.value = "";
    error.textContent = "PIN verified. Check your email for the one-time sign-in link.";
    submitButton.textContent = "Email sent";
  } catch {
    error.textContent = "Connection failed. Check your connection and try again.";
  } finally {
    if (submitButton.textContent !== "Email sent") {
      submitButton.disabled = false;
      submitButton.textContent = "Continue";
      field.focus();
    }
  }
});
