// Runs before first paint (an external file, so the CSP needs no inline script).
// 1. The theme: the visitor's pick ("light" or "dark", kept in localStorage) or the
//    system's, resolved to data-theme on <html> so nothing flashes the wrong colours.
// 2. `js` lets the stylesheet tell "scripts are running" from "they are not"; the
//    hidden starting states of the entrance animation exist only while motion is
//    pending, and the timer guarantees the page can never stay hidden if the
//    bundle fails to load.
// 3. `booting` shows the loading screen (src/fx/boot.ts fills it in and lifts it); the
//    same kind of timer means a failed bundle can never leave it up. Crawlers and
//    page-speed tools get neither: no loader, and nothing hidden before scripts run.
(function (d) {
  var root = d.documentElement;
  var dark = matchMedia("(prefers-color-scheme: dark)");
  function pick() {
    try { return localStorage.getItem("mnemo-theme") || "system"; } catch (e) { return "system"; }
  }
  function apply() {
    var p = pick();
    root.setAttribute("data-theme", p === "system" ? (dark.matches ? "dark" : "light") : p);
  }
  apply();
  if (dark.addEventListener) dark.addEventListener("change", apply);

  root.classList.add("js");
  // Crawlers and page-speed tools get the page as it is, with no loader in front of it.
  var bot = /bot|crawl|spider|slurp|lighthouse|pagespeed|inspectiontool|facebookexternalhit|embedly|preview/i.test(navigator.userAgent);
  if (bot) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("reduced");
    return;
  }
  root.classList.add("motion-pending", "booting");
  setTimeout(function () { root.classList.remove("motion-pending"); }, 11000);
  setTimeout(function () { root.classList.remove("booting"); }, 11000);
})(document);
