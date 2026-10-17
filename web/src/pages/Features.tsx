import { PageHead } from "./parts";
import { DemoScroll } from "../sections/DemoScroll";
import { Memory } from "../sections/Memory";
import { Lessons } from "../sections/Lessons";
import { Skills } from "../sections/Skills";
import { Checks } from "../sections/Checks";
import { Fleet } from "../sections/Fleet";
import { Modes } from "../sections/Modes";
import { Tools } from "../sections/Tools";
import { Agents } from "../sections/Agents";
import { Palette } from "../sections/Palette";
import { Themes } from "../sections/Themes";
import { Measured } from "../sections/Measured";

const REEL: [string, string, string][] = [
  ["demo", "One turn", "Ask, read, edit, check, answer, remember."],
  ["memory", "Memory", "What it remembers, and how you control it."],
  ["lessons", "Lessons", "A failure leaves a pitfall with its fix."],
  ["skills", "Skills", "Procedures it writes down for itself."],
  ["checks", "Checks", "Nothing is done until the checks pass."],
  ["fleet", "Fleet", "Several agents, one window."],
  ["safety", "Permissions", "Four modes and rules that always hold."],
  ["tools", "Tools", "What the agent can reach for."],
  ["other-agents", "Shared memory", "Claude Code and Codex can use it too."],
  ["commands", "Commands", "Everything you can type."],
  ["themes", "Themes", "Why it looks like a game."],
  ["measured", "Measured", "Does memory make a small model better?"],
];

export function Features() {
  return (
    <div className="page features">
      <div className="wrap">
        <PageHead
          eyebrow="Features"
          title="Everything Mnemo does, each one working"
          lead={<>Every feature below has a demo built from the app's own text: the turn <code>mnemo --demo</code> plays, the gate's rules, the real command list and themes. Scroll the reel or jump to one.</>}
        />
      </div>
      <section className="reel" data-scene="reel" aria-label="Features at a glance">
        <ol className="reel-track">
          {REEL.map(([id, title, body], i) => (
            <li key={id} className="reel-card" data-reveal="">
              <a href={`#${id}`}>
                <span className="reel-n">№{String(i + 1).padStart(2, "0")}</span>
                <strong>{title}</strong>
                <span>{body}</span>
              </a>
            </li>
          ))}
        </ol>
      </section>
      <DemoScroll />
      <div className="wrap sections">
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
      </div>
    </div>
  );
}
