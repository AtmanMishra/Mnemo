import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Split } from "../Split";
import { useMotionOK, useSequence } from "../hooks";

// A simulated Mnemo window, one scene per feature, the way product pages show an app
// rebuilt in HTML rather than filmed. The text comes from the app: the `--demo` turn
// (app/src/runtime/demo.ts), the approval prompt (app/src/policy/prompt.ts), the keys
// in content/commands.ts and the agent limits in docs/MNEMO-INTERNALS.md.

const SCENES = [
  { id: "ask", tab: "Asks first", title: "It asks before it edits", body: "Every edit and command waits for you by default. Allow it and the change is checked before it is called done; refuse it and nothing is written." },
  { id: "memory", tab: "Memory", title: "Next session, it remembers", body: "What the last run learned is recalled before the model sees your message: the project's facts, what was decided and what was left open. Turn memory off to see the difference." },
  { id: "sub", tab: "Sub-agents", title: "Agents start their own helpers", body: "An agent can hand parts of a task to sub-agents, and they can start their own, three levels deep. Each one shows its task, its steps and its answer." },
  { id: "split", tab: "Split view", title: "Up to four agents side by side", body: "ctrl+s splits the screen, alt+l changes the layout, and a sub-agent that starts while its agent is on screen takes a pane of its own." },
  { id: "siblings", tab: "Siblings", title: "Linked agents talk to each other", body: "Link two agents in the hub and they see what the other is doing and send each other messages, marked as another agent's words, never yours. Limits you can see keep it bounded." },
  { id: "themes", tab: "Themes", title: "Eleven palettes, same roles", body: "/theme switches the look and keeps the meaning: one colour for the agent, one for structure, one for anything memory did. Pick one; every scene here follows it." },
  { id: "code", tab: "Code index", title: "It looks up code instead of guessing", body: "The agent asks an index of your project where something is defined and what calls it, and after an edit it is told what elsewhere calls what changed. Turn it off with the codeIndex setting." },
  { id: "hooks", tab: "Hooks", title: "Your own check before a command runs", body: "A hook is a command you chose, run before or after a tool call. It can refuse a call but never allow one, and a hook that fails refuses too. Hooks come only from your own hooks.json, never from a project." },
  { id: "schedule", tab: "Schedules", title: "A prompt on a timer", body: "mnemo schedule runs a prompt on a timer, read-only unless you gave the job actions, and never in yolo mode. Jobs live only in your own folder." },
] as const;
type SceneId = (typeof SCENES)[number]["id"];

const THEMES = [
  ["night", "Mnemo Night"], ["gameboy", "Game Boy"], ["paper", "Paper"], ["dracula", "Dracula"], ["nord", "Nord"], ["gruvbox", "Gruvbox"],
  ["tokyo", "Tokyo Night"], ["mocha", "Catppuccin"], ["solarized", "Solarized"], ["amber", "Amber CRT"], ["synthwave", "Synthwave"],
] as const;
type ThemeId = (typeof THEMES)[number][0];

export const L = ({ g, c, children }: { g: string; c: string; children: ReactNode }) => (
  <div className={`sc-ln ${c}`}><b aria-hidden="true">{g}</b><span>{children}</span></div>
);

function Ask() {
  const { ref, step } = useSequence<HTMLDivElement>(3, 700);
  // The server and reduced motion show the allowed outcome; a visitor chooses.
  const motion = useMotionOK();
  const [choice, setChoice] = useState<"once" | "deny" | null>(null);
  useEffect(() => setChoice(motion ? null : "once"), [motion]);
  const shown = choice ?? (motion ? null : "once");
  return (
    <div ref={ref} className="sc-log">
      <L g="▊" c="you">add a retry to the fetch helper</L>
      {step >= 1 && <L g="·" c="think">I should read it first, then retry only on server errors so a 404 still fails fast.</L>}
      {step >= 2 && <L g="●" c="tool">read <i>src/fetch.ts</i> <em>5 lines</em></L>}
      {step >= 3 && (
        <>
          <L g="●" c="tool">edit <i>src/fetch.ts</i></L>
          <pre className="sc-diff"><span className="d">-  const res = await fetch(url);</span><span className="a">+  for (let attempt = 1; ; attempt++) {"{"}</span><span className="a">+    if (res.ok) return res.json();</span><span className="a">+    if (attempt === 3 || res.status &lt; 500) throw …</span></pre>
          {shown === null ? (
            <div className="sc-ask" role="group" aria-label="Approve the edit">
              <p>? edit src/fetch.ts</p>
              <button type="button" onClick={() => setChoice("once")}><kbd>1</kbd> allow once <em>run it this time only</em></button>
              <button type="button" disabled><kbd>2</kbd> always, this project</button>
              <button type="button" onClick={() => setChoice("deny")}><kbd>4</kbd> don't allow <em>leave it unrun</em></button>
            </div>
          ) : shown === "once" ? (
            <>
              <L g="✓" c="ok">allowed once</L>
              <L g="●" c="tool">bash <i>git diff --check &amp;&amp; git diff --stat</i></L>
              <L g=" " c="out">src/fetch.ts | 9 <span className="g">++++++</span><span className="r">---</span></L>
              <L g="│" c="agent">Done: server errors retry up to three times with backoff; 4xx still fail on the first try.</L>
              <L g="◆" c="mem">learned 2 facts · 1 open: no test covers the retry path yet</L>
            </>
          ) : (
            <>
              <L g="✗" c="bad">you did not allow this</L>
              <L g="│" c="agent">Understood, I left src/fetch.ts as it was. Nothing was written.</L>
            </>
          )}
          {shown !== null && motion && <button type="button" className="sc-again" onClick={() => setChoice(null)}>Ask again</button>}
        </>
      )}
    </div>
  );
}

function Memory() {
  const [on, setOn] = useState(true);
  const { ref, step, replay } = useSequence<HTMLDivElement>(4, 600);
  const flip = () => { setOn((v) => !v); replay(); };
  return (
    <div ref={ref} className="sc-log">
      <div className="sc-tools">
        <span className="mut">a new session, the next day</span>
        <button type="button" role="switch" aria-checked={on} onClick={flip}>memory {on ? "on" : "off"}</button>
      </div>
      <L g="▊" c="you">write a test for the retry</L>
      {on ? (
        <>
          {step >= 1 && (
            <div className="sc-recall">
              <p>◆ recalled 3 from memory</p>
              <p>http helper: getJson (src/fetch.ts) retries 5xx up to 3 times with backoff; 4xx fail fast</p>
              <p>language: TypeScript</p>
              <p>open: no test covers the retry path yet</p>
            </div>
          )}
          {step >= 2 && <L g="│" c="agent">Last session left this open. I'll test the 5xx retry and that a 404 fails at once.</L>}
          {step >= 3 && <L g="●" c="tool">read <i>src/fetch.ts</i> <em>14 lines</em></L>}
          {step >= 4 && <L g="●" c="tool">write <i>src/fetch.test.ts</i> <em>asks first</em></L>}
        </>
      ) : (
        <>
          {step >= 1 && <L g="│" c="agent">Which retry? I'll look for it first.</L>}
          {step >= 2 && <L g="●" c="tool">grep <i>retry</i> <em>3 files</em></L>}
          {step >= 3 && <L g="●" c="tool">read <i>src/api/client.ts</i> <em>88 lines</em></L>}
          {step >= 4 && <L g="●" c="tool">read <i>src/fetch.ts</i> <em>14 lines</em></L>}
        </>
      )}
      <p className="sc-note">{on ? "Recalled before the model was asked anything." : "Without memory it starts from nothing and searches."}</p>
    </div>
  );
}

interface Node { id: string; task: string; depth: number; at: number; done: number; steps: string[]; answer: string }
const TREE: Node[] = [
  { id: "#1", task: "add rate limiting to the API", depth: 0, at: 0, done: 6, steps: ["spawn_subagent map where requests are sent", "spawn_subagent find the tests that cover fetch"], answer: "Rate limit added in src/api/client.ts, covered by two tests." },
  { id: "#1.1", task: "map where requests are sent", depth: 1, at: 1, done: 4, steps: ["spawn_subagent read every file in src/api", "grep fetch( src"], answer: "Every request goes through getJson in src/fetch.ts." },
  { id: "#1.1.1", task: "read every file in src/api", depth: 2, at: 2, done: 3, steps: ["read src/api/client.ts", "read src/api/routes.ts"], answer: "Two files; both call getJson." },
  { id: "#1.2", task: "find the tests that cover fetch", depth: 1, at: 1, done: 5, steps: ["grep getJson test", "read test/fetch.test.ts"], answer: "One test file; it has no case for a 429." },
];

function SubAgents() {
  const { ref, step, replay } = useSequence<HTMLDivElement>(6, 650);
  const [sel, setSel] = useState("#1.1");
  const cur = TREE.find((n) => n.id === sel) ?? TREE[0]!;
  const status = (n: Node) => (step < n.at ? null : step >= n.done ? "done" : "running");
  return (
    <div ref={ref} className="sc-sub">
      <ul className="sc-tree" aria-label="Agents and sub-agents">
        {TREE.map((n) => {
          const s = status(n);
          return s && (
            <li key={n.id} className={`dep-${n.depth}`}>
              <button type="button" aria-pressed={sel === n.id} onClick={() => setSel(n.id)}>
                <b>{n.depth ? "└ " : ""}{n.id}</b> {n.task} <em className={s}>{s === "done" ? "✓ done" : "● running"}</em>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="sc-node" aria-live="polite">
        <p className="sc-h">{cur.id} · depth {cur.depth}</p>
        {cur.steps.map((s) => <L key={s} g="●" c="tool">{s}</L>)}
        {step >= cur.done && <L g="│" c="agent">{cur.answer}</L>}
      </div>
      <div className="sc-tools">
        <span className="mut">depth 3 · 4 live children each · 16 live per root</span>
        <button type="button" onClick={replay}>Run again</button>
      </div>
    </div>
  );
}

function Code() {
  const { ref, step, replay } = useSequence<HTMLDivElement>(5, 700);
  return (
    <div ref={ref} className="sc-log">
      <L g="▊" c="you">rename getJson to fetchJson</L>
      {step >= 1 && <L g="●" c="tool">code_refs <i>getJson</i> <em>callers</em></L>}
      {step >= 1 && (
        <pre className="sc-diff"><span>getJson is used by:</span><span>{"  "}loadList  src/pages/list.tsx:12</span><span>{"  "}loadItem  src/pages/item.tsx:8</span><span>{"  "}+ 1 call to a getJson the index could not tie to one definition (grep finds them)</span></pre>
      )}
      {step >= 2 && <L g="│" c="agent">Two callers, plus one it could not place. I'll check that one with grep.</L>}
      {step >= 3 && <L g="●" c="tool">edit <i>src/fetch.ts</i> <em>asks you first</em></L>}
      {step >= 4 && (
        <L g="◆" c="mem">This edit changed definitions that other code calls (check they still fit): fetchJson ← loadList src/pages/list.tsx:12</L>
      )}
      <div className="sc-tools">
        <span className="mut">code_search · code_symbol · code_refs · code_map</span>
        <button type="button" onClick={replay}>Run again</button>
      </div>
      <p className="sc-note">Matches are exact or marked inferred; calls it cannot tie to one place are counted, not guessed.</p>
    </div>
  );
}

function Hooks() {
  const { ref, step, replay } = useSequence<HTMLDivElement>(4, 700);
  const [on, setOn] = useState(true);
  const flip = () => { setOn((v) => !v); replay(); };
  return (
    <div ref={ref} className="sc-log">
      <div className="sc-tools">
        <span className="mut">~/.mnemo/hooks.json</span>
        <button type="button" role="switch" aria-checked={on} onClick={flip}>PreToolUse hook {on ? "on" : "off"}</button>
      </div>
      <pre className="sc-diff"><span>{`{ "hooks": { "PreToolUse": [{ "matcher": "bash",`}</span><span>{`    "command": "~/bin/check-command", "timeout": 30 }] } }`}</span></pre>
      <L g="▊" c="you">clean up the build output</L>
      {step >= 1 && <L g="●" c="tool">bash <i>rm -rf dist</i></L>}
      {step >= 2 && <L g="✓" c="ok">the permission gate let it through</L>}
      {on ? (
        <>
          {step >= 3 && <L g="✗" c="bad">hook refused (exit 2): dist is the release folder, use `bun run clean`</L>}
          {step >= 4 && <L g="│" c="agent">The check says to use `bun run clean`; trying that.</L>}
        </>
      ) : (
        step >= 3 && <L g="●" c="tool">ran <i>rm -rf dist</i> <em>no hook</em></L>
      )}
      <p className="sc-note">A hook can refuse a call, never allow one the gate refused. A hook that times out or is missing refuses too.</p>
    </div>
  );
}

function Schedule() {
  const [actions, setActions] = useState(false);
  const { ref, step, replay } = useSequence<HTMLDivElement>(3, 700);
  const flip = () => { setActions((v) => !v); replay(); };
  return (
    <div ref={ref} className="sc-log">
      <div className="sc-tools">
        <span className="mut">a job that runs every weekday at 09:00</span>
        <button type="button" role="switch" aria-checked={actions} onClick={flip}>--actions {actions ? "on" : "off"}</button>
      </div>
      <L g="▊" c="you">mnemo schedule add "summarise yesterday's failing tests"{actions ? " --actions" : ""}</L>
      {step >= 1 && <L g="●" c="tool">09:00 · mnemo -p{actions ? "" : " --plan"} <em>child process</em></L>}
      {step >= 2 && <L g="│" c="agent">{actions ? "Edits and commands still go through the gate and your deny rules; this is never yolo." : "Read-only: it can read and report, and cannot edit or run a command."}</L>}
      {step >= 3 && <L g="◆" c="mem">log saved, secrets redacted · last 20 runs kept</L>}
      <p className="sc-note">Nothing starts by itself: <code>mnemo schedule run</code> stays in the foreground.</p>
    </div>
  );
}

const LAYOUTS = ["columns", "rows", "grid", "main + side"] as const;
const PANES = [
  { id: "#1", t: "api", l: ["▊ add rate limiting", "● edit src/api/client.ts"] },
  { id: "#2", t: "web", l: ["▊ fix the empty state", "│ Done."] },
  { id: "↳ #1.1", t: "sub-agent", l: ["map where requests are sent", "● grep fetch( src"] },
  { id: "#3", t: "docs", l: ["▊ document the limits", "● read README.md"] },
];

function SplitView({ armed }: { armed: boolean }) {
  const [split, setSplit] = useState(true);
  const [lay, setLay] = useState(0);
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); setSplit((v) => !v); }
      else if (e.altKey && e.code === "KeyL") { e.preventDefault(); setLay((v) => (v + 1) % LAYOUTS.length); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);
  const shown = split ? PANES : [PANES[focus]!];
  return (
    <div className="sc-split-wrap">
      <div className="sc-tools">
        <button type="button" aria-pressed={split} onClick={() => setSplit((v) => !v)}><kbd>ctrl+s</kbd> split view</button>
        <button type="button" disabled={!split} onClick={() => setLay((v) => (v + 1) % LAYOUTS.length)}><kbd>alt+l</kbd> {LAYOUTS[lay]}</button>
      </div>
      <div className={split ? `sc-split lay-${lay}` : "sc-split one"}>
        {shown.map((p) => {
          const i = PANES.indexOf(p);
          return (
            <button key={p.id} type="button" className={i === focus ? "sc-pane on" : "sc-pane"} onClick={() => setFocus(i)}>
              <span className="sc-h">{p.id} {p.t}</span>
              {p.l.map((x) => <span key={x}>{x}</span>)}
            </button>
          );
        })}
      </div>
      <p className="sc-note">Click a pane to focus it, as <kbd>alt+,</kbd> and <kbd>alt+.</kbd> do; a sub-agent pane takes your typing too.</p>
    </div>
  );
}

function Siblings() {
  const [linked, setLinked] = useState(false);
  const { ref, step, replay } = useSequence<HTMLDivElement>(4, 700);
  const motion = useMotionOK();
  const talk = linked || !motion;
  const link = () => { setLinked(true); replay(); };
  return (
    <div ref={ref} className="sc-sib">
      <div className={talk ? "sc-hub linked" : "sc-hub"}>
        <div className="sc-card"><b>#1 api</b><span>renaming the client</span></div>
        <i className="sc-wire" aria-hidden="true">{talk ? "━━ linked ━━" : "┄┄┄┄┄┄┄┄"}</i>
        <div className="sc-card"><b>#2 web</b><span>{talk && step >= 3 ? "woken by #1" : "idle"}</span></div>
      </div>
      {talk ? (
        <div className="sc-log">
          {step >= 1 && <L g="●" c="tool">message_agent <i>#2</i></L>}
          {step >= 2 && <L g="✉" c="mem">from #1, not from you: I renamed getJson to fetchJson in src/api/client.ts; update your imports.</L>}
          {step >= 3 && <L g="│" c="agent">#2: Updating the two imports in src/pages.</L>}
          {step >= 4 && <L g="●" c="tool">edit <i>src/pages/list.tsx</i> <em>asks you first</em></L>}
        </div>
      ) : (
        <p className="sc-note">Two agents on one project. Unlinked, neither can reach the other.</p>
      )}
      <div className="sc-tools">
        <span className="mut">12 messages in a row, then they wait for you · $0.50 per woken agent</span>
        {motion && <button type="button" onClick={linked ? () => setLinked(false) : link}><kbd>l</kbd> {linked ? "unlink" : "link #1 and #2"}</button>}
      </div>
    </div>
  );
}

function Themes({ theme, setTheme }: { theme: ThemeId; setTheme: (t: ThemeId) => void }) {
  return (
    <div className="sc-log">
      <div className="sc-themes" role="radiogroup" aria-label="Theme">
        {THEMES.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={id === theme} onClick={() => setTheme(id)}>{label}</button>
        ))}
      </div>
      <L g="▊" c="you">/theme</L>
      <L g="│" c="agent">agent text</L>
      <L g="●" c="tool">structure: tools, paths <i>src/fetch.ts</i></L>
      <L g="◆" c="mem">anything memory did</L>
      <pre className="sc-diff"><span className="a">+ added</span><span className="d">- removed</span></pre>
    </div>
  );
}

export function Showcase() {
  const [cur, setCur] = useState<SceneId>("ask");
  const [theme, setTheme] = useState<ThemeId>("night");
  const [armed, setArmed] = useState(false);
  const scene = SCENES.find((s) => s.id === cur)!;

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = SCENES.findIndex((s) => s.id === cur);
    const next = e.key === "ArrowDown" || e.key === "ArrowRight" ? i + 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const s = SCENES[(next + SCENES.length) % SCENES.length]!;
    setCur(s.id);
    document.getElementById(`sc-tab-${s.id}`)?.focus();
  };

  return (
    <section className="show-sec" aria-labelledby="show-h">
      <div className="wrap">
        <p className="eyebrow" data-reveal=""><span className="ribbon-tag">Try it here</span></p>
        <Split id="show-h" text="See what it does" />
        <div className="show-grid">
          <div className="show-side">
            <div className="show-tabs" role="tablist" aria-label="Features" aria-orientation="vertical" onKeyDown={onTabKey}>
              {SCENES.map((s, i) => (
                <button key={s.id} id={`sc-tab-${s.id}`} type="button" role="tab" aria-selected={s.id === cur} aria-controls="sc-panel" tabIndex={s.id === cur ? 0 : -1} onClick={() => setCur(s.id)}>
                  <span aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>{s.tab}
                </button>
              ))}
            </div>
            <div className="show-copy" aria-live="polite">
              <h3>{scene.title}</h3>
              <p>{scene.body}</p>
            </div>
          </div>
          <div className="show-desk" onPointerEnter={() => setArmed(true)} onPointerLeave={() => setArmed(false)}>
            <div id="sc-panel" role="tabpanel" aria-labelledby={`sc-tab-${cur}`} className={`th sc-win th-${theme}`}>
              <div className="sc-bar" aria-hidden="true"><i /><i /><i /><span>mnemo · ~/shop</span></div>
              <div className="sc-body" key={cur}>
                {cur === "ask" && <Ask />}
                {cur === "memory" && <Memory />}
                {cur === "sub" && <SubAgents />}
                {cur === "split" && <SplitView armed={armed} />}
                {cur === "siblings" && <Siblings />}
                {cur === "code" && <Code />}
                {cur === "hooks" && <Hooks />}
                {cur === "schedule" && <Schedule />}
                {cur === "themes" && <Themes theme={theme} setTheme={setTheme} />}
              </div>
              <div className="sc-status" aria-hidden="true"><span>default</span><span>{THEMES.find((t) => t[0] === theme)![1]}</span></div>
            </div>
          </div>
        </div>
        <p className="fine" data-reveal="">A simulation built from the app's own text. <code>mnemo --demo</code> plays a real session with no API key.</p>
      </div>
    </section>
  );
}
