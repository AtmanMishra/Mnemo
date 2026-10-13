import type { ReactNode } from "react";
import { Hero } from "../Hero";
import { Install } from "../Install";
import { Split } from "../Split";
import { DemoScroll } from "../sections/DemoScroll";
import { Memory } from "../sections/Memory";
import { Lessons } from "../sections/Lessons";
import { Skills } from "../sections/Skills";
import { Figure } from "../Figure";
import { Checks } from "../sections/Checks";
import { Fleet } from "../sections/Fleet";
import { Modes } from "../sections/Modes";
import { Tools } from "../sections/Tools";
import { Agents } from "../sections/Agents";
import { Palette } from "../sections/Palette";
import { Themes } from "../sections/Themes";
import { Measured } from "../sections/Measured";
import { REPO } from "../site";

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

export function Home() {
  return (
    <>
        <div className="wrap">
          <Hero />
          <Install />
        </div>
        <DemoScroll />
        <div className="wrap">
          <Memory />
          <Lessons />
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
            <div className="f-head with-fig">
              <div>
                <p className="eyebrow" data-reveal=""><span>13</span> questions</p>
                <Split id="faq" text="Questions people ask" />
                <p className="lead-sm" data-reveal="">Straight answers, with the details in the repository when you want them.</p>
              </div>
              <Figure name="query" label="A question mark built as a bent bar over a loose ball; the hook turns toward the pointer and the ball rolls after it" means="Ask: the answer turns toward you." />
            </div>
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
          </>
  );
}
