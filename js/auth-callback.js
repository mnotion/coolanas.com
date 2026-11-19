import { createClient } from "https://esm.sh/@supabase/supabase-js@2.119.0";

const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
const OWNER_USER_ID = "bfc1c21b-11a1-4020-9a2f-2846dd4069bf";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    experimental: { passkey: true }
  }
});

const status = document.getElementById("status");

async function finishEmailVerification() {
  status.textContent = "Verifying your email link…";
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session || data.session.user.id !== OWNER_USER_ID) {
    await supabase.auth.signOut();
    status.textContent = "This verification link is invalid, expired, or belongs to a different account. Return to the PIN page and request a new link.";
    return;
  }
  sessionStorage.setItem("coolanas-pin-unlocked", "1");
  status.textContent = "Email verified. Opening fingerprint setup…";
  location.replace("dashboard.html");
}

finishEmailVerification();
