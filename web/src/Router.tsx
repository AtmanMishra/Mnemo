import { useEffect, useState } from "react";
import { App } from "./App";
import { normalize, routeFor } from "./routes";
import { cover, uncover } from "./fx/transition";
import { jumpTo, pageSet } from "./motion";

const full = (title: string, path: string) => (path === "/" ? title : `${title} · Mnemo`);

/** The head tags the prerender wrote for each page, kept true as pages change in place. */
function setHead(path: string) {
  const r = routeFor(path);
  if (!r) return;
  const title = full(r.title, path);
  const url = `https://mnemo.atmanmishra.dev${path}`;
  document.title = title;
  const set = (sel: string, attr: string, v: string) => document.head.querySelector(sel)?.setAttribute(attr, v);
  set('meta[name="description"]', "content", r.description);
  set('link[rel="canonical"]', "href", url);
  set('meta[property="og:title"]', "content", title);
  set('meta[property="og:description"]', "content", r.description);
  set('meta[property="og:url"]', "content", url);
}

/**
 * Changes pages without reloading, so the stage, the scroll engine and the visit carry
 * over and the change can be a transition. Every page is still a real prerendered file:
 * this only takes over clicks on links to them, and the browser's back and forward.
 */
export function Router({ initial }: { initial: string }) {
  const [path, setPath] = useState(normalize(initial));

  useEffect(() => {
    let busy = false;
    const go = async (to: string, hash: string, push: boolean) => {
      if (busy) return;
      busy = true;
      const label = routeFor(to)?.label ?? "Mnemo";
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      try {
        if (!still) await cover(label);
        if (push) history.pushState(null, "", to + hash);
        document.documentElement.classList.add("motion-pending");
        setPath(to);
        setHead(to);
        const set = pageSet();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await jumpTo(hash);
        await set;
        if (!still) await uncover(label);
      } finally {
        busy = false;
      }
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!a || a.target || a.hasAttribute("download") || a.origin !== location.origin) return;
      const to = normalize(a.pathname);
      if (!routeFor(to) || /\.[a-z0-9]+$/i.test(a.pathname)) return;
      if (to === normalize(location.pathname)) {
        if (!a.hash) {
          e.preventDefault();
          void jumpTo("");
        }
        return;
      }
      e.preventDefault();
      void go(to, a.hash, true);
    };
    const onPop = () => {
      const to = normalize(location.pathname);
      if (routeFor(to)) void go(to, location.hash, false);
    };
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  return <App path={path} />;
}
