import { Hero } from "./Hero";
import { Install } from "./Install";
import { Split } from "./Split";
import { AUTHOR, BUILD_DATE, REPO } from "./site";
import { useEffect, type ReactNode } from "react";

const steps = [
  { n: "01", title: "Learn", body: "After each run Mnemo writes down what it learned about the project and about you: commands that worked, rules the code does not reveal, mistakes to avoid." },
  { n: "02", title: "Recall", body: "Next session it recalls what applies to the project you are in. Memory is kept per project, so a command learned in one repository is not offered in another." },
  { n: "03", title: "Fix", body: "When something failed, it keeps the fix, so the same mistake is not made twice. What it holds is yours to read with /memory and delete with /forget." },
];

const cards = [
  { glyph: "◈", title: "It remembers", body: <>Memory is local. It is written after each run, recalled next session, and yours to read (<code>/memory</code>) and delete (<code>/forget</code>).</> },
  { glyph: "◇", title: "Memory is detachable", body: <>One command prints the hooks and MCP entry that attach the same memory to Claude Code or Codex: <code>mnemo memory setup claude-code</code>. What one agent learns, the others recall.</> },
  { glyph: "▣", title: "Many agents, one window", body: <>A hub of every agent and what it is doing, split view for up to four, a project switcher, and a toast when one you are not watching finishes or needs you.</> },
  { glyph: "▞", title: "Pixels, on purpose", body: <>Mne the elephant reacts to the work; diffs and test runs are drawn as pixels; the memory map shows what it holds. Three themes: Night, Game Boy, Paper.</> },
];

const shots = [
  { name: "hub", w: 1260, h: 844, alt: "The Mnemo hub: a card for each agent with its status, its last prompt and one pixel per turn", cap: <>The hub: every agent at a glance. <kbd>ctrl+g</kbd></> },
  { name: "split", w: 1260, h: 826, alt: "Three Mnemo agents side by side in a split view", cap: <>Split view: up to four agents side by side. <kbd>ctrl+s</kbd></> },
  { name: "memory-map", w: 1170, h: 808, alt: "The Mnemo memory map: the project in the middle, its facts, pitfalls and sessions around it", cap: <>The memory map: what it knows about this project.</> },
  { name: "best-of", w: 846, h: 556, alt: "Best-of-three as a race of lanes, the winner in green, then the exit card with Mne waving", cap: <><code>/bestof</code>: three attempts race, the smallest that passes the check wins.</> },
];

const results = [
  { test: "Six tasks in one repo, with rules the code does not reveal (3 runs)", without: "87%", withMem: "100%", win: true },
  { test: "Two repos whose rules conflict (2 runs)", without: "82%", withMem: "99%", win: true },
  { test: "Terminal-Bench subset: 10 easy/medium tasks, one attempt each", without: "10 / 10", withMem: "10 / 10", win: false },
];

const faq: { q: string; a: ReactNode }[] = [
  { q: "What is Mnemo?", a: <>Mnemo is an open-source terminal coding agent with a memory that learns your projects. It reads your files, edits them and runs commands as you, asks before it does, and remembers what it learned for the next session. You bring the model.</> },
  { q: "Is Mnemo free?", a: <>Yes. Mnemo is free and open source under the Apache-2.0 license, and the <a href={REPO}>source is on GitHub</a>. You pay only your model provider for the tokens you use.</> },
  { q: "Which models does Mnemo work with?", a: <>You choose the provider and the model. The measurements on this page were run on a small, cheap model (DeepSeek v4.1 Flash), with memory on and off through the same agent loop.</> },
  { q: "How do I install Mnemo?", a: <>Run the one-line installer for your system from the <a href="#install">install section</a>. No Bun, Node or Rust is needed. Then run <code>mnemo doctor</code> to see what it found and <code>mnemo --demo</code> for a scripted session that needs no API key.</> },
  { q: "Does Mnemo collect telemetry?", a: <>No. There is no telemetry and no update check. Your prompts and the files the model reads go to the provider you chose, and nothing else leaves your machine.</> },
  { q: "Is it safe to run on my code?", a: <>By default Mnemo asks before every edit and command. The permission gate filters what runs; it is not a sandbox. <code>yolo</code> mode and headless <code>-p</code> ask for nothing, so use those in a container or a throwaway checkout. <a href={`${REPO}/blob/main/SECURITY.md`}>SECURITY.md</a> has the details.</> },
  { q: "Does Mnemo's memory work with Claude Code or Codex?", a: <>Yes. <code>mnemo memory setup claude-code</code> prints the hooks and MCP entry that attach the same memory to Claude Code or Codex, so what one agent learns the others recall.</> },
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

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="wrap bar">
          <a className="brand" href="/" aria-label="Mnemo home" translate="no"><img src="/favicon.svg" alt="" width="24" height="24" />mnemo</a>
          <nav aria-label="Primary">
            <a href="#install">install</a>
            <a href="#memory">memory</a>
            <a href="#interface">interface</a>
            <a href="#measured">measured</a>
            <a href="#faq">faq</a>
            <a href={REPO}>github</a>
          </nav>
        </div>
      </header>

      <main id="main" className="wrap">
        <Hero />
        <Install />

        <section aria-labelledby="memory">
          <Split id="memory" text="How does Mnemo's memory work?" />
          <ol className="steps">
            {steps.map((s) => (
              <li key={s.n} data-reveal="">
                <span className="n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="what">
          <Split id="what" text="What can Mnemo do?" />
          <div className="grid">
            {cards.map((c) => (
              <div className="card" key={c.title} data-reveal="">
                <span className="glyph" aria-hidden="true">{c.glyph}</span>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="interface">
          <Split id="interface" text="What does the interface look like?" />
          <div className="shots">
            {shots.map((s) => (
              <figure key={s.name} data-reveal="">
                <picture>
                  <source srcSet={`/img/${s.name}.webp`} type="image/webp" />
                  <img src={`/img/${s.name}.png`} alt={s.alt} width={s.w} height={s.h} loading="lazy" decoding="async" />
                </picture>
                <figcaption>{s.cap}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section aria-labelledby="measured">
          <Split id="measured" text="Does the memory make a small model better?" />
          <p className="fine" data-reveal="">
            On a small, cheap model (DeepSeek v4.1 Flash), memory took a six-task repository from 87% to 100% and two repositories with
            conflicting rules from 82% to 99%. On unrelated one-off tasks it made no difference. Small samples: read the direction, not
            the decimals. The raw results and what went wrong along the way are in <a href={`${REPO}/tree/main/research`}>research/</a>.
          </p>
          <div className="table" data-reveal="">
            <table>
              <caption className="visually-hidden">Pass rate with and without Mnemo's memory, same agent loop, DeepSeek v4.1 Flash</caption>
              <thead><tr><th scope="col">Test</th><th scope="col">No memory</th><th scope="col">With memory</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.test}><th scope="row">{r.test}</th><td className="n">{r.without}</td><td className={r.win ? "n good" : "n"}>{r.withMem}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine" data-reveal="">
            The last row is the honest one: unrelated one-off tasks in a fresh container give memory nothing to remember, and it makes no
            difference there (about $0.008 a task either way). It is a subset on our own machine, not comparable to the public
            leaderboard. The first two are where memory is supposed to pay off. Against a simpler, global memory in the style of Hermes
            Agent, Mnemo matched it at one or two repos and was ahead where it keeps projects apart (a command learned in one project was
            offered in another) and picks up unfinished work. The comparison is written up in{" "}
            <a href={`${REPO}/blob/main/research/hermes-comparison.md`}>research/hermes-comparison.md</a>.
          </p>
        </section>

        <section aria-labelledby="faq">
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

        <section aria-labelledby="safety">
          <Split id="safety" text="What should I know before I run it?" />
          <p data-reveal="">Mnemo is a coding agent: it reads your files, edits them and runs shell commands as you. By default it asks before every edit and command; <code>yolo</code> and headless <code>-p</code> ask for nothing, so use those in a container or a throwaway checkout. The permission gate filters what runs; it is not a sandbox.</p>
          <p data-reveal="">Your prompts and the files the model reads go to the provider you chose, and nothing else leaves your machine: there is no telemetry and no update check (we measured it). Commands the agent runs inherit your environment, provider keys included, which a prompt injection could try to read; <a href={`${REPO}/blob/main/SECURITY.md`}>SECURITY.md</a> says what to do about that today. It is pre-alpha software: expect rough edges and <a href={`${REPO}/issues`}>tell us about them</a>.</p>
        </section>

        <section className="final" aria-labelledby="final-h">
          <Split id="final-h" text="Give your agent a memory" />
          <p className="cta" data-reveal="">
            <a className="btn primary" href="#install">Install Mnemo</a>
            <a className="btn" href={`${REPO}/releases`}>Releases</a>
          </p>
        </section>
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
