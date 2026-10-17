import type { ReactNode } from "react";
import { Install } from "../Install";
import { Split } from "../Split";
import { Seal } from "../Seal";
import { GraphPlay } from "../GraphPlay";
import { Showcase } from "../sections/Showcase";
import { REPO, VERSION } from "../site";

const MARQUEE = ["An elephant never forgets", "Neither does your agent", "Bring your own model", "Memory stays on your machine", "No telemetry", "Open source"];

const BEATS: { n: string; side: "l" | "r"; title: string; body: ReactNode }[] = [
  { n: "01", side: "l", title: "Every run leaves a mark.", body: <>After each run, one grounded reflection writes down what it learned: the facts you stated or a tool showed, what was decided, what is still open, and the fix for anything that failed.</> },
  { n: "02", side: "r", title: "Memory is a graph, not a pile.", body: <>Each memory is a node, linked by typed edges (part of, derived from, supersedes) and filed into six areas, from episodic to executive. Recall follows the links one hop out, so related memories come along.</> },
  { n: "03", side: "l", title: "Written down, plain as day.", body: <>Everything is one append-only journal on your machine, a line per change. Replaying it gives back the whole graph. Nothing is ever erased: a changed fact supersedes the old one and the old one stays as history.</> },
  { n: "04", side: "r", title: "Next session, it remembers.", body: <>Before the model sees your message, memory is searched for it and what it finds is attached: the project's facts, your preferences, pitfalls with their fixes, the skills it wrote. On a small model, that took one repo from 87% of tasks done right to 100%.</> },
];

const CARDS: { href: string; tag: string; title: string; body: string; tone: string }[] = [
  { href: "/features#memory", tag: "Memory", title: "Learns your project", body: "Facts, decisions and open threads, recalled next session and kept on your machine.", tone: "teal" },
  { href: "/features#lessons", tag: "Lessons", title: "Keeps the fix", body: "When something fails and a later step fixes it, the fix is kept with the pitfall.", tone: "red" },
  { href: "/features#skills", tag: "Skills", title: "Writes its own skills", body: "Procedures it will need again, as plain SKILL.md files you can read and edit.", tone: "mustard" },
  { href: "/features#checks", tag: "Checks", title: "Checks its work", body: "Runs the project's checks before it calls a change done, and races attempts when stuck.", tone: "salmon" },
  { href: "/features#safety", tag: "Safety", title: "Asks before it acts", body: "Every edit and command waits for you by default. Four modes, and rules that always hold.", tone: "plum" },
  { href: "/features#fleet", tag: "Fleet", title: "Many agents, one window", body: "Start more agents, split the screen four ways, and let them answer each other.", tone: "olive" },
];

const faq: { q: string; a: ReactNode }[] = [
  { q: "What is Mnemo?", a: <>Mnemo is an open-source terminal coding agent with a memory that learns your projects. It reads your files, edits them and runs commands as you, asks before it does, and remembers what it learned for the next session. You bring the model.</> },
  { q: "Is Mnemo free?", a: <>Yes. Mnemo is free and open source under the Apache-2.0 license, and the <a href={REPO}>source is on GitHub</a>. You pay only your model provider for the tokens you use.</> },
  { q: "Which models does Mnemo work with?", a: <>You choose the provider and the model: <code>/login</code> adds a provider key or subscription and <code>/model</code> picks one. It also uses credentials it finds in your environment, such as <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code>.</> },
  { q: "How do I install Mnemo?", a: <>Run the one-line installer for your system from the <a href="#install">install section</a>, or <a href="/download">download an archive</a>. No Bun, Node or Rust is needed. Then <code>mnemo doctor</code> shows what it found and <code>mnemo --demo</code> plays a scripted session that needs no API key.</> },
  { q: "Does Mnemo collect telemetry?", a: <>No. There is no telemetry, and no update check unless you turn one on (<code>mnemo update --auto on</code>). Your prompts and the files the model reads go to the provider you chose, and nothing else leaves your machine.</> },
  { q: "Where is the memory stored?", a: <>On your machine, in Mnemo's memory sidecar (<code>memsrv</code>): an append-only journal that is the only source of truth. Credentials live separately in <code>~/.mnemo/auth.json</code> with mode 0600.</> },
  { q: "Is it safe to run on my code?", a: <>By default Mnemo asks before every edit and command. The permission gate filters what runs; it is not a sandbox. Commands it runs inherit your environment, provider keys included, so use <code>/yolo</code> and headless <code>-p</code> in a container or a throwaway checkout. <a href={`${REPO}/blob/main/SECURITY.md`}>SECURITY.md</a> has the details.</> },
  { q: "How do I update Mnemo?", a: <>Run <code>mnemo update</code>, or <code>/update</code> inside Mnemo: it installs the latest release with the same checksum-checked installer. <code>mnemo update --auto on</code> adds a daily check at launch that tells you when there is a new version and never installs on its own. Homebrew and Scoop installs use <code>brew upgrade mnemo</code> and <code>scoop update mnemo</code>.</> },
  { q: "How do I remove Mnemo?", a: <>Run the installer again with the uninstall flag: <code>… | sh -s -- --uninstall</code>. On Windows, set <code>$env:MNEMO_UNINSTALL=1</code> first. Your memory and settings are never touched by the installer.</> },
];

export function Marquee({ words, rev }: { words: string[]; rev?: boolean }) {
  const run = (
    <>
      {words.map((w) => (
        <span key={w}>{w}<b aria-hidden="true">★</b></span>
      ))}
    </>
  );
  return (
    <div className={rev ? "marquee rev" : "marquee"} data-marquee={rev ? "rev" : ""} aria-hidden="true">
      <div className="mq-track">{run}{run}{run}{run}</div>
    </div>
  );
}

export function Home() {
  return (
    <>
      <section className="hero" aria-labelledby="top">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="hero-tag" data-intro=""><span className="ribbon-tag">Pre-alpha · open source · Apache-2.0</span></p>
            <Split as="h1" id="top" text="A terminal coding agent that never forgets your project" hero />
            <p className="lead" data-intro="">
              <strong>Mnemo is an open-source terminal coding agent</strong> for macOS, Linux and Windows. After each run it writes
              down what it learned about your project, recalls it next session, keeps the fix when something failed, and writes skills
              for itself. Bring your own model; memory stays on your machine.
            </p>
            <p className="cta" data-intro="">
              <a className="btn primary big" href="#install">Install Mnemo</a>
              <a className="btn big alt" href="/how-it-works">How it works</a>
            </p>
            <p className="facts" data-intro="">v{VERSION} · macOS · Linux · Windows · no Bun, Node or Rust needed</p>
          </div>
          <div className="hero-art">
            <div className="hero-slot" data-stage-anchor="" aria-hidden="true">
              <img className="hero-still" src="/mne.svg" alt="" width="240" height="240" />
            </div>
            <div className="hero-stamp" data-stamp=""><Seal label="Mne" sub="★ est. 2026 ★" /></div>
            <p className="hero-note" data-intro="">Mne, our elephant, is made of memories. Move the pointer; scroll to take it apart.</p>
          </div>
        </div>
        <p className="scroll-cue" aria-hidden="true"><span>scroll</span><i /></p>
      </section>

      <Marquee words={MARQUEE} />

      <section className="story" data-scene="story" aria-labelledby="story-h">
        <div className="story-sticky" aria-hidden="true"><div className="story-anchor" data-story-anchor="" /></div>
        <div className="wrap story-beats">
          <p className="eyebrow center" data-reveal=""><span className="ribbon-tag">How it remembers</span></p>
          <Split id="story-h" text="Take the elephant apart and you find a memory" />
          {BEATS.map((b) => (
            <article key={b.n} className={`beat-card side-${b.side}`} data-side={b.side}>
              <p className="beat-n">{b.n}</p>
              <h3>{b.title}</h3>
              <p>{b.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="stats" data-after-story="" aria-labelledby="stats-h">
        <div className="wrap">
          <h2 id="stats-h" className="visually-hidden">Measured</h2>
          <ul className="stat-row">
            <li data-reveal=""><b><span data-count="87">87</span>→<span data-count="100">100</span>%</b><span>six tasks in one repo, small model, memory off → on</span></li>
            <li data-reveal=""><b><span data-count="82">82</span>→<span data-count="99">99</span>%</b><span>two repos whose rules conflict</span></li>
            <li data-reveal=""><b><span data-count="0">0</span></b><span>telemetry. Nothing leaves but what you send your provider</span></li>
            <li data-reveal=""><b><span data-count="3">3</span></b><span>systems: macOS, Linux and Windows, one archive each</span></li>
          </ul>
          <p className="fine" data-reveal="">Small samples on DeepSeek v4.1 Flash; read the direction, not the decimals. <a href="/features#measured">What we measured</a>.</p>
        </div>
      </section>

      <section className="cards-sec" aria-labelledby="cards-h">
        <div className="wrap">
          <p className="eyebrow" data-reveal=""><span className="ribbon-tag">What it does</span></p>
          <Split id="cards-h" text="A good memory, and good manners" />
          <ul className="adcards">
            {CARDS.map((c, i) => (
              <li key={c.href} className={`adcard tone-${c.tone}`} data-reveal="">
                <a href={c.href}>
                  <span className="adcard-tag">{c.tag}</span>
                  <span className="adcard-n" aria-hidden="true">№{String(i + 1).padStart(2, "0")}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                  <span className="adcard-go" aria-hidden="true">Read more »</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Showcase />

      <section className="play-sec" aria-labelledby="play-h">
        <div className="wrap play-grid">
          <div>
            <p className="eyebrow" data-reveal=""><span className="ribbon-tag">Hands on</span></p>
            <Split id="play-h" text="Poke the memory" />
            <p className="lead-sm" data-reveal="">This is the shape of one project's memory after a few sessions. Run a session and watch it recall what it needs, then leave something behind. Change a fact and the new value supersedes the old one, which stays as history.</p>
            <p className="lead-sm" data-reveal=""><a href="/how-it-works">How the real one works »</a></p>
          </div>
          <GraphPlay />
        </div>
      </section>

      <Marquee words={["Asks before it acts", "Checks its work", "Writes its own skills", "Keeps the fix", "Many agents, one window"]} rev />

      <section className="install-sec" aria-label="Install">
        <div className="wrap">
          <div className="tv" data-reveal="">
            <div className="tv-screen"><Install /></div>
            <div className="tv-side" aria-hidden="true">
              <i className="knob" /><i className="knob" />
              <span className="tv-grille" />
              <span className="tv-brand">MNEMO</span>
            </div>
          </div>
        </div>
      </section>

      <section className="faq-sec" aria-labelledby="faq">
        <div className="wrap">
          <p className="eyebrow" data-reveal=""><span className="ribbon-tag">Questions</span></p>
          <Split id="faq" text="Questions people ask" />
          <div className="faq">
            {faq.map((f) => (
              <details key={f.q} className="qa" data-reveal="">
                <summary><h3>{f.q}</h3></summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="final" aria-labelledby="final-h">
        <div className="wrap">
          <div className="final-seal" data-speed="0.4"><Seal sub="★ give it a memory ★" /></div>
          <Split id="final-h" text="Give your agent a memory" />
          <p className="lead-sm" data-reveal="">Pre-alpha, open source, and honest about its rough edges. <a href={`${REPO}/issues`}>Tell us what you find.</a></p>
          <p className="cta" data-reveal="">
            <a className="btn primary big" href="/download">Download Mnemo</a>
            <a className="btn big alt" href={`${REPO}/releases`}>Releases</a>
          </p>
        </div>
      </section>
    </>
  );
}
