const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
// Sign-in screen, theme preference, and session redirect.
const googleButton = document.getElementById("google-login");
const status = document.getElementById("login-status");
const themeToggle = document.getElementById("theme-toggle");
const themeIcon = document.getElementById("theme-icon");
const savedTheme = localStorage.getItem("coolanas-theme");
const initialTheme =
    savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark";
  themeIcon.textContent = dark ? "☀" : "☾";
  themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  themeToggle.setAttribute("aria-pressed", String(dark));
  document.querySelector("meta[name=\"theme-color\"]").content = dark ? "#111111" : "#ffffff";
}
applyTheme(initialTheme);
themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("coolanas-theme", next);
  applyTheme(next);
});
const greetings = [
  "Welcome", "Hello", "Hey there", "Good to see you", "Nice to see you", "Welcome back",
  "Hello again", "Good day", "Glad you're here", "Let's get started"
];
document.getElementById("greeting").textContent =
    greetings[Math.floor(Math.random() * greetings.length)];
let supabase;
async function getClient() {
  if (!supabase) {
    const {createClient} = await import("https://esm.sh/@supabase/supabase-js@2.119.0");
    supabase = createClient(
        SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
        {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}});
  }
  return supabase;
}
googleButton.addEventListener("click", async () => {
  googleButton.disabled = true;
  status.hidden = false;
  status.textContent = "Redirecting to Google…";
  try {
    const client = await getClient();
    const {error} = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: "https://coolanas.com/dashboard.html",
        queryParams: {prompt: "select_account"}
      }
    });
    if (error) throw error;
  } catch (error) {
    status.textContent = error?.message || "Google sign-in could not start. Try again.";
    googleButton.disabled = false;
  }
});
(async () => {
  try {
    const client = await getClient();
    const {data: {session}, error} = await client.auth.getSession();
    if (error) throw error;
    if (session) location.replace("dashboard.html");
  } catch (error) {
    status.hidden = false;
    status.textContent = error?.message || "Could not check your sign-in session.";
  }
})();
