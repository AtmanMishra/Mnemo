import { useEffect, useRef, useState } from "react";
import { Split } from "./Split";

const SEEDS = [7, 11, 23, 42, 64, 99];

export function Hero() {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<{ setSeed(n: number): void; destroy(): void } | null>(null);
  const [seedIndex, setSeedIndex] = useState(0);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    void import("./art/engram").then(({ createEngram }) => {
      if (cancelled || !canvas.current) return;
      engine.current = createEngram(canvas.current, { reducedMotion: reduced, onFrame: () => setLive(true) });
    });
    return () => {
      cancelled = true;
      engine.current?.destroy();
      engine.current = null;
    };
  }, []);

  const step = (by: number) => {
    const next = (seedIndex + by + SEEDS.length) % SEEDS.length;
    setSeedIndex(next);
    engine.current?.setSeed(SEEDS[next]!);
  };
  const seed = SEEDS[seedIndex]!;

  return (
    <section className="hero" aria-labelledby="top">
      <div className="hero-copy">
        <p className="tag" data-intro="">pre-alpha · open source · Apache-2.0</p>
        <Split as="h1" id="top" text="A terminal coding agent that remembers your project" hero />
        <p className="lead" data-intro="">
          <strong>Mnemo is an open-source terminal coding agent</strong> for macOS, Linux and Windows. After each run it writes
          down what it learned about your project, recalls it next session, keeps the fix when something failed, and writes skills
          for itself. Bring your own model; memory stays on your machine.
        </p>
        <p className="cta" data-intro="">
          <a className="btn primary" href="#install">Install Mnemo</a>
          <a className="btn" href="#demo">See a turn</a>
        </p>
        <p className="facts" data-intro="">v0.1.0 · macOS · Linux · Windows · no Bun, Node or Rust needed</p>
      </div>

      <figure className="stage-wrap" data-intro="">
        <div ref={stage} className={live ? "stage live" : "stage"}>
          <img className="stage-still" src="/mne.svg" alt="Mne, the pixel elephant mascot: elephants never forget" width="220" height="220" {...{ fetchpriority: "high" }} />
          <canvas ref={canvas} role="img" aria-label="Characters drifting across a grid and settling into a pixel elephant, Mne. Move the pointer over it to light the characters." />
          <div className="seedbar" role="group" aria-label="Animation seed">
            <button type="button" onClick={() => step(-1)} aria-label="Previous seed">‹</button>
            <span aria-live="polite">engram №{seed}</span>
            <button type="button" onClick={() => step(1)} aria-label="Next seed">›</button>
          </div>
        </div>
        <figcaption>A seeded field of characters settling into Mne, the project's elephant. Each seed settles in a different order; hover to recall.</figcaption>
      </figure>
    </section>
  );
}
