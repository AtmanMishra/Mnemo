import { useState } from "react";
import { Section } from "./Section";
import { useSequence } from "../hooks";
import { mulberry32 } from "../art/rng";

const VERIFY = [
  { g: "●", c: "tool", t: "edit src/cart.ts" },
  { g: "│", c: "agent", t: "Done, the discount now rounds down." },
  { g: "↺", c: "warn", t: "sent back: code changed and nothing was run" },
  { g: "●", c: "tool", t: "bash pnpm test" },
  { g: "✓", c: "ok", t: "42 passed" },
];

const ESCALATE = [
  { g: "●", c: "tool", t: "bash pnpm test" },
  { g: "✗", c: "bad", t: "2 failed" },
  { g: "●", c: "tool", t: "bash pnpm test" },
  { g: "✗", c: "bad", t: "1 failed" },
  { g: "⇡", c: "warn", t: "escalated to provider/strong-model after 2 failed checks" },
  { g: "✓", c: "ok", t: "all passed" },
];

function Log({ lines, step }: { lines: typeof VERIFY; step: number }) {
  return (
    <div className="log">
      {lines.map((l, i) => (
        <div key={i} className={i < step ? `ln ${l.c} in` : `ln ${l.c}`}><b>{l.g}</b>{l.t}</div>
      ))}
    </div>
  );
}

interface Lane { lines: number; pass: boolean; }
function race(seed: number): Lane[] {
  const r = mulberry32(seed);
  const lanes = [0, 1, 2].map(() => ({ lines: 3 + Math.floor(r() * 14), pass: r() > 0.35 }));
  if (!lanes.some((l) => l.pass)) lanes[Math.floor(r() * 3)]!.pass = true;
  return lanes;
}

export function Checks() {
  const v = useSequence<HTMLDivElement>(VERIFY.length, 520);
  const e = useSequence<HTMLDivElement>(ESCALATE.length, 520);
  const [seed, setSeed] = useState(4);
  const [round, setRound] = useState(0);
  const lanes = race(seed);
  const winner = lanes.reduce<number>((best, l, i) => (l.pass && (best < 0 || l.lines < lanes[best]!.lines) ? i : best), -1);
  const b = useSequence<HTMLDivElement>(2, 1300);
  const settled = b.step >= 2;

  return (
    <Section
      id="checks"
      n="05"
      eyebrow="it checks its work"
      title="How does Mnemo know a change actually works?"
      lead={<>It runs the project's checks before it calls a change done, moves to a stronger model when they keep failing, and can race several attempts and keep the smallest one that passes.</>}
      figure={{ name: "format", label: "A file of ten crooked lines; the pointer runs the formatter down it and every line above snaps square", means: "Nothing counts as done until the checks have run over it and everything has snapped square." }}
      how={[
        { t: "Verify before done", d: <>A run that changed code and ran nothing is sent back once, to run the project's checks: the test, typecheck, lint and build commands memory knows for this project. A change is checked before it is called done.</> },
        { t: "Escalate when the checks keep failing", d: <>With <code>--escalate provider/id</code>, after the checks fail twice the rest of the run moves to the stronger model, and a note in the transcript says why. The cheap model does the work it can; the expensive one only finishes what it could not.</> },
        { t: "Best of n", d: <><code>mnemo -p "&lt;task&gt;" --best-of 3 --check "npm test"</code>, or <code>/bestof</code> in the interface, runs attempts in separate git worktrees, runs the check in each, and applies the smallest change that passed. Every candidate's diff is kept, and if none passes nothing is applied.</> },
        { t: "Headless", d: <><code>mnemo -p "&lt;task&gt;"</code> runs one task and prints the answer, which suits scripts and CI. It never asks, so run it in a container or a throwaway checkout.</> },
      ]}
    >
      <div className="checks">
        <article className="check" data-reveal="">
          <h3>Verify before done</h3>
          <p>A run that changed code and ran nothing is sent back once to run the project's checks.</p>
          <div ref={v.ref}><Log lines={VERIFY} step={v.step} /></div>
          <button type="button" className="replay" onClick={v.replay} aria-label="Replay verify before done">↻ replay</button>
        </article>
        <article className="check" data-reveal="">
          <h3>Escalate</h3>
          <p><code>--escalate provider/id</code> finishes a run on a stronger model after two failed checks.</p>
          <div ref={e.ref}><Log lines={ESCALATE} step={e.step} /></div>
          <button type="button" className="replay" onClick={e.replay} aria-label="Replay escalate">↻ replay</button>
        </article>
        <article className="check race" data-reveal="">
          <h3>Best of three</h3>
          <p><code>/bestof</code> or <code>--best-of 3 --check "pnpm test"</code>: three attempts in separate worktrees; the smallest passing change is applied.</p>
          <div ref={b.ref} className="lanes" aria-live="polite">
            {lanes.map((l, i) => {
              const done = settled;
              const state = !done ? "run" : l.pass ? (i === winner ? "win" : "pass") : "fail";
              return (
                <div key={`${round}-${i}`} className={`lane ${state}`}>
                  <span className="n">{i + 1}</span>
                  <i><b className={b.step >= 1 ? "go" : ""} /></i>
                  <span className="res">{!done ? "checking…" : l.pass ? `✓ ${l.lines} lines${i === winner ? " · applied" : ""}` : "✗ check failed"}</span>
                </div>
              );
            })}
          </div>
          <button type="button" className="replay" onClick={() => { setSeed((s) => s + 1); setRound((r) => r + 1); b.replay(); }}>↻ race again</button>
        </article>
      </div>
    </Section>
  );
}
