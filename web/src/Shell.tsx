import { useEffect, type ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { AUTHOR, BUILD_DATE, REPO, VERSION } from "./site";

const NAV: [string, string][] = [
  ["/docs", "docs"],
  ["/shortcuts", "shortcuts"],
  ["/changelog", "changelog"],
  ["/roadmap", "roadmap"],
  ["/security", "security"],
];

const COLUMNS: { title: string; links: [string, string][] }[] = [
  { title: "Product", links: [["/", "Overview"], ["/download", "Download"], ["/docs", "Documentation"], ["/shortcuts", "Commands and shortcuts"]] },
  { title: "Project", links: [["/changelog", "Changelog"], ["/roadmap", "Roadmap"], [REPO, "Source on GitHub"], [`${REPO}/releases`, "Releases"], [`${REPO}/issues`, "Issues"], [`${REPO}/blob/main/CONTRIBUTING.md`, "Contribute"]] },
  { title: "Trust", links: [["/security", "Security"], ["/privacy", "Privacy policy"], ["/terms", "Terms of use"], [`${REPO}/blob/main/LICENSE`, "Apache-2.0 license"]] },
];

const external = (href: string) => /^https?:/.test(href);

/** The header, footer and page behaviour every page shares. */
export function Shell({ path, children }: { path: string; children: ReactNode }) {
  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;
    void import("./motion").then(async ({ initMotion }) => {
      const stop = await initMotion(document.getElementById("root")!);
      if (cancelled) stop();
      else cleanup = stop;
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  // Reading progress: a hairline under the header. State, not decoration, so it stays under reduced motion.
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>(".progress i");
    if (!bar) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
    };
    const onScroll = () => (raf ||= requestAnimationFrame(paint));
    window.addEventListener("scroll", onScroll, { passive: true });
    paint();
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <div className="progress" aria-hidden="true"><i /></div>
      <header className="top">
        <div className="wrap bar">
          <a className="brand" href="/" aria-label="Mnemo home" translate="no"><img src="/favicon.svg" alt="" width="24" height="24" />mnemo</a>
          <nav aria-label="Primary">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} aria-current={path === href ? "page" : undefined}>{label}</a>
            ))}
            <a href={REPO}>github</a>
            <a className="nav-cta" href="/download" aria-current={path === "/download" ? "page" : undefined}>download</a>
          </nav>
          <ThemeToggle />
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="foot">
        <div className="wrap">
          <div className="foot-grid">
            <div className="foot-about">
              <a className="brand" href="/" translate="no"><img src="/favicon.svg" alt="" width="24" height="24" />mnemo</a>
              <p>A terminal coding agent that remembers your project. Open source, Apache-2.0, no telemetry.</p>
              <p className="foot-ver">v{VERSION} · <a href="/changelog">what changed</a></p>
            </div>
            {COLUMNS.map((c) => (
              <nav key={c.title} aria-label={c.title}>
                <h2>{c.title}</h2>
                <ul>
                  {c.links.map(([href, label]) => (
                    <li key={href}><a href={href} {...(external(href) ? { rel: "noopener" } : {})}>{label}</a></li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
          <p className="foot-line">
            <span>Built by <a href={AUTHOR.url} rel="author">{AUTHOR.name}</a></span>
            <span>Figures: <a href="https://hairline.lucasmarkes.com">Hairline</a> by Lucas Marques (MIT)</span>
            <span>Updated <time dateTime={BUILD_DATE}>{BUILD_DATE}</time></span>
            <a href="/changelog.xml">feed</a>
          </p>
        </div>
      </footer>
    </>
  );
}
