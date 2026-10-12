import { useState } from "react";
import { Section } from "./Section";
import { useSequence } from "../hooks";

// An example of what `create_skill` writes and `update_skill` revises. The paths
// and the history rule are the real ones (app/src/extensions/skills.ts).
const VERSIONS = [
  {
    tag: "v1",
    note: "create_skill: it noticed a procedure worth keeping.",
    lines: ["---", "name: run-checks", "description: Use before calling a change done in this repo.", "---", "1. pnpm typecheck", "2. pnpm test", "3. Report what failed, with the command that showed it."],
  },
  {
    tag: "v2",
    note: "update_skill, reason: tests hung on the dev server port. v1 is kept in skill-history/.",
    lines: ["---", "name: run-checks", "description: Use before calling a change done in this repo.", "---", "1. pnpm typecheck", "2. pnpm test --runInBand", "   (in parallel they fight over the dev server port)", "3. Report what failed, with the command that showed it."],
  },
];

export function Skills() {
  const [v, setV] = useState(1);
  const ver = VERSIONS[v]!;
  const seq = useSequence<HTMLDivElement>(ver.lines.length, 110);
  const prev = new Set(VERSIONS[0]!.lines);

  return (
    <Section
      id="skills"
      n="04"
      eyebrow="skills it writes for itself"
      title="Can Mnemo learn a procedure, not just a fact?"
      lead={<>Yes. When it notices a procedure the project will need again, it writes a skill: a plain <code>SKILL.md</code> you can read and edit, in the repository's <code>.agents/skills/</code> (or your own, for a personal one), and a node in memory so a later session can find it by purpose. When a skill fails, it rewrites it and keeps the old version.</>}
      figure={{ name: "riffle", label: "A tray of eight cards; the card under the pointer stands up, and the arrow keys walk the cards", means: "A tray of procedures it wrote for itself: pull one up, and the ones beside it follow." }}
      how={[
        { t: "Written when a procedure is demonstrated", d: <><code>create_skill</code> saves a procedure the project or you will need again: a lowercase-with-dashes name, a description that says when to use it (that is how it is found later), and the steps, commands and pitfalls in Markdown. A project skill goes in the repository's <code>.agents/skills/&lt;name&gt;/SKILL.md</code>; a personal one in Mnemo's home.</> },
        { t: "Indexed in memory", d: <>Every skill is also a procedural node in memory, so a later session can recall that the skill exists, and why, from a question that never names it.</> },
        { t: "Revised, with its history", d: <>When a skill fails, <code>update_skill</code> rewrites it and says what went wrong with the old version. The previous body is kept under <code>skill-history/</code>.</> },
        { t: "Loaded from where you already keep them", d: <><code>SKILL.md</code> files in <code>.claude</code>, <code>.pi</code> and <code>.agents</code> folders, walked up to the repository root, load as well. <code>/skills</code> lists them and <code>/reload</code> picks up changes without a restart.</> },
        { t: "Curated so the list stays short", d: <><code>mnemo memory curate</code> sorts skills by last use: stale after 30 days, archivable after 90. With <code>--apply</code> a personal skill moves to <code>skills-archive/</code>, where nothing is lost but it is no longer loaded. A project skill belongs to the team: it is reported, never moved.</> },
      ]}
    >
      <div className="skill" data-reveal="">
        <div className="skill-tabs" role="tablist" aria-label="Skill version">
          {VERSIONS.map((x, i) => (
            <button key={x.tag} type="button" role="tab" aria-selected={i === v} onClick={() => { setV(i); seq.replay(); }}>
              {x.tag}
            </button>
          ))}
          <span className="skill-path">.agents/skills/run-checks/SKILL.md</span>
        </div>
        <div ref={seq.ref} className="skill-file" role="tabpanel">
          <pre>
            {ver.lines.map((l, i) => (
              <span key={`${v}-${i}`} className={[i < seq.step ? "in" : "", v === 1 && !prev.has(l) ? "changed" : ""].join(" ")}>{l || " "}</span>
            ))}
          </pre>
        </div>
        <p className="skill-note"><span className="tagline">{ver.tag}</span>{ver.note}</p>
      </div>
      <p className="fine" data-reveal="">An example skill. Skills from <code>.claude</code>, <code>.pi</code> and <code>.agents</code> folders load too, and <code>/skills</code> lists what it can use.</p>
    </Section>
  );
}
