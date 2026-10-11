// Runs before first paint (an external file, so the CSP needs no inline script).
// `js` lets the stylesheet tell "scripts are running" from "they are not"; the
// hidden starting states of the entrance animation exist only while motion is
// pending, and the timer guarantees the page can never stay hidden if the bundle
// fails to load.
(function (d) {
  var root = d.documentElement;
  root.classList.add("js");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("reduced");
    return;
  }
  root.classList.add("motion-pending");
  setTimeout(function () { root.classList.remove("motion-pending"); }, 4000);
})(document);
