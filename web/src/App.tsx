import { useEffect, type ReactNode } from "react";
import { Hero } from "./Hero";
import { Install } from "./Install";
import { Split } from "./Split";
import { DemoScroll } from "./sections/DemoScroll";
import { Memory } from "./sections/Memory";
import { Skills } from "./sections/Skills";
import { Checks } from "./sections/Checks";
import { Fleet } from "./sections/Fleet";
import { Modes } from "./sections/Modes";
import { Tools } from "./sections/Tools";
import { Agents } from "./sections/Agents";
import { Palette } from "./sections/Palette";
import { Themes } from "./sections/Themes";
import { Measured } from "./sections/Measured";
import { AUTHOR, BUILD_DATE, REPO } from "./site";

const faq: { q: string; a: ReactNode }[] = [
  { q: "What is Mnemo?", a: <>Mnemo is an open-source terminal coding agent with a memory that learns your projects. It reads your files, edits them and runs commands as you, asks before it does, and remembers what it learned for the next session. You bring the model.</> },
  { q: "Is Mnemo free?", a: <>Yes. Mnemo is free and open source under the Apache-2.0 license, and the <a href={REPO}>source is on GitHub</a>. You pay only your model provider for the tokens you use.</> },
  { q: "Which models does Mnemo work with?", a: <>You choose the provider and the model: <code>/login</code> adds a provider key or subscription and <code>/model</code> picks one. It also uses credentials it finds in your environment, such as <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code>.</> },
  { q: "How do I install Mnemo?", a: <>Run the one-line installer for your system from the <a href="#install">install section</a>. No Bun, Node or Rust is needed. Then <code>mnemo doctor</code> shows what it found and <code>mnemo --demo</code> plays a scripted session that needs no API key.</> },
  { q: "Does Mnemo collect telemetry?", a: <>No. There is no telemetry and no update check. Your prompts and the files the model reads go to the provider you chose, and nothing else leaves your machine.</> },
  { q: "Where is the memory stored?", a: <>On your machine, in Mnemo's memory sidecar (<code>memsrv</code>): an append-only journal that is the only source of truth. Credentials live separately in <code>~/.mnemo/auth.json</code> with mode 0600.</> },
  { q: "Is it safe to run on my code?", a: <>By default Mnemo asks before every edit and command. The permission gate filters what runs; it is not a sandbox. Commands it runs inherit your environment, provider keys included, so use <code>/yolo</code> and headless <code>-p</code> in a container or a throwaway checkout. <a href={`${REPO}/blob/main/SECURITY.md`}>SECURITY.md</a> has the details.</> },
  { q: "How do I remove Mnemo?", a: <>Run the installer again with the uninstall flag: <code>… | sh -s -- --uninstall</code>. On Windows, set <code>$env:MNEMO_UNINSTALL=1</code> first. Your memory and settings are never touched by the installer.</> },
];

export function App() {
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
            <a href="#demo">demo</a>
            <a href="#memory">memory</a>
            <a href="#skills">skills</a>
            <a href="#checks">checks</a>
            <a href="#fleet">agents</a>
            <a href="#safety">safety</a>
            <a href="#faq">faq</a>
            <a href={REPO}>github</a>
            <a className="nav-cta" href="#install">install</a>
          </nav>
        </div>
      </header>

      <main id="main">
        <div className="wrap">
          <Hero />
          <Install />
        </div>
        <DemoScroll />
        <div className="wrap">
          <Memory />
          <Skills />
          <Checks />
          <Fleet />
          <Modes />
          <Tools />
          <Agents />
          <Palette />
          <Themes />
          <Measured />

          <section className="feature" aria-labelledby="faq">
            <p className="eyebrow" data-reveal=""><span>12</span> questions</p>
            <Split id="faq" text="Questions people ask" />
            <div className="faq">
              {faq.map((f) => (
                <div key={f.q} className="qa" data-reveal="">
                  <h3>{f.q}</h3>
                  <p>{f.a}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="final" aria-labelledby="final-h">
            <Split id="final-h" text="Give your agent a memory" />
            <p className="lead-sm" data-reveal="">Pre-alpha, open source, and honest about its rough edges. <a href={`${REPO}/issues`}>Tell us what you find.</a></p>
            <p className="cta" data-reveal="">
              <a className="btn primary" href="#install">Install Mnemo</a>
              <a className="btn" href={`${REPO}/releases`}>Releases</a>
            </p>
          </section>
        </div>
      </main>

      <footer className="wrap foot">
        <span>Apache-2.0</span>
        <span>Built by <a href={AUTHOR.url} rel="author">{AUTHOR.name}</a></span>
        <a href={REPO}>source</a>
        <a href={`${REPO}/releases`}>releases</a>
        <a href={`${REPO}/blob/main/SECURITY.md`}>security</a>
        <a href={`${REPO}/blob/main/docs/ROADMAP.md`}>roadmap</a>
        <a href={`${REPO}/blob/main/CONTRIBUTING.md`}>contribute</a>
        <span>Updated <time dateTime={BUILD_DATE}>{BUILD_DATE}</time></span>
      </footer>
    </>
  );
}
