/* Shared site-wide appearance bootstrap. Runs before page styles to prevent a light-mode flash. */
(() => {
  const root = document.documentElement;
  const read = () => {
    try { return localStorage.getItem("coolanas-theme") === "dark" ? "dark" : "light"; }
    catch { return "light"; }
  };
  const apply = mode => {
    const dark = mode === "dark";
    root.classList.toggle("dark-mode", dark);
    root.dataset.theme = dark ? "dark" : "light";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? "#17191d" : "#ffffff";
  };
  const set = mode => {
    const value = mode === "dark" ? "dark" : "light";
    try { localStorage.setItem("coolanas-theme", value); } catch {}
    apply(value);
    window.dispatchEvent(new CustomEvent("coolanas:themechange", {detail:{mode:value}}));
  };
  apply(read());
  window.addEventListener("storage", event => {
    if (event.key === "coolanas-theme") apply(event.newValue === "dark" ? "dark" : "light");
  });
  window.CoolanasTheme = {get:read, set, apply};
})();
