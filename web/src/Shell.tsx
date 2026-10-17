import { useEffect, useRef, type ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { Seal } from "./Seal";
import { AUTHOR, BUILD_DATE, REPO, VERSION } from "./site";

const LEFT: [string, string][] = [
  ["/features", "Features"],
  ["/how-it-works", "How it works"],
  ["/docs", "Docs"],
];
const RIGHT: [string, string][] = [
  ["/changelog", "Changelog"],
  ["/shortcuts", "Keys"],
];

const COLUMNS: { title: string; links: [string, string][] }[] = [
  { title: "Product", links: [["/", "Overview"], ["/features", "Features"], ["/how-it-works", "How it works"], ["/download", "Download"], ["/docs", "Documentation"], ["/shortcuts", "Commands and shortcuts"]] },
  { title: "Project", links: [["/changelog", "Changelog"], ["/roadmap", "Roadmap"], [REPO, "Source on GitHub"], [`${REPO}/releases`, "Releases"], [`${REPO}/issues`, "Issues"], [`${REPO}/blob/main/CONTRIBUTING.md`, "Contribute"]] },
  { title: "Trust", links: [["/security", "Security"], ["/privacy", "Privacy policy"], ["/terms", "Terms of use"], [`${REPO}/blob/main/LICENSE`, "Apache-2.0 license"]] },
];

const external = (href: string) => /^https?:/.test(href);

/** The header, footer, stage and page behaviour every page shares. */
export function Shell({ path, children }: { path: string; children: ReactNode }) {
  const stage = useRef<HTMLCanvasElement>(null);
  const main = useRef<HTMLElement>(null);

  // The stage is mounted once for the visit; the router swaps pages over it.
  useEffect(() => {
    if (stage.current) void import("./fx/host").then(({ mountStage }) => mountStage(stage.current!));
  }, []);

  // Every page: point the stage at it, and run its motion.
  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;
    void Promise.all([import("./motion"), import("./fx/host")]).then(async ([{ pageMotion }, { stagePage }]) => {
      if (cancelled || !main.current) return;
      void stagePage(path);
      const stop = await pageMotion(main.current);
      if (cancelled) stop();
      else cleanup = stop;
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [path]);

  // Reading progress: a bar under the header. State, not decoration, so it stays under reduced motion.
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

  const link = ([href, label]: [string, string]) => (
    <a key={href} href={href} aria-current={path === href ? "page" : undefined}>{label}</a>
  );

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <canvas ref={stage} className="stage-canvas" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      <div className="progress" aria-hidden="true"><i /></div>
      <header className="top">
        <div className="bar">
          <nav className="nav-l" aria-label="Primary">{LEFT.map(link)}</nav>
          <a className="brand" href="/" aria-label="Mnemo home" translate="no">
            <Seal />
          </a>
          <nav className="nav-r" aria-label="More">
            {RIGHT.map(link)}
            <a href={REPO}>GitHub</a>
            <a className="nav-cta" href="/download" aria-current={path === "/download" ? "page" : undefined}>Download</a>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main id="main" ref={main} key={path}>{children}</main>

      <footer className="foot">
        <div className="foot-band" aria-hidden="true"><i /><i /><i /><i /></div>
        <div className="wrap">
          <div className="foot-grid">
            <div className="foot-about">
              <a className="foot-seal" href="/" aria-label="Mnemo home" translate="no"><Seal sub="★ open source ★" /></a>
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
          <p className="foot-big" aria-hidden="true" translate="no">MNEMO</p>
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
