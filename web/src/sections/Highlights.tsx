import { useState, type KeyboardEvent } from "react";
import { Split } from "../Split";
import { REPO } from "../site";
import { L } from "./Showcase";

// The five newest features, newest first, each with a small working demo. The text comes from
// the app: the tool results and refusals in app/src/extensions/agents.ts, peers.ts and team.ts,
// runtime/team.ts (TASK.md, LOG.md), runtime/session-files.ts and registry/cli.ts, and the
// defaults in docs/SETTINGS.md. When a pull request merges, change its `status`; when a newer
// feature lands, it goes first and the last one drops off.

type Status = "released" | "on main" | "in review";

const ITEMS = [
  { id: "team", pr: 83, status: "in review" as Status, tag: "Teams", tone: "teal", title: "A shared plan and log per run", body: "Once a second agent works on what you asked, they share a TASK.md and a LOG.md. Agents claim steps with task_update, only a step's owner marks it done, and each turn starts with what the others did." },
  { id: "runs", pr: 82, status: "on main" as Status, tag: "@N", tone: "red", title: "Talk to any agent by number", body: "Every agent has a number. @2 at the start of a prompt is your words to agent #2. One prompt of yours is a run: capped at 40 messages and $1.00 of woken turns, and r r stops all of it." },
  { id: "saved", pr: 81, status: "on main" as Status, tag: "Saved", tone: "mustard", title: "Sub-agents are saved with the conversation", body: "Each sub-agent's transcript is kept beside the conversation, with a state file that lists every agent it started: model, limits, turns, spend and answer. SubagentStart and SubagentStop hooks can log or refuse delegation." },
  { id: "registry", pr: 80, status: "on main" as Status, tag: "Registry", tone: "plum", title: "Every agent on the machine", body: "mnemo agents lists what runs in every terminal and project, and tells, steers or stops one from anywhere. It is all local files: no socket, no server, and approvals stay in the terminal that asks." },
  { id: "limits", pr: 79, status: "on main" as Status, tag: "Limits", tone: "olive", title: "Pick a sub-agent's model and limits", body: "Settings choose the model sub-agents run on and their turns, budget, thinking and context. A parent may lower any of them for one task, never raise one past yours, and the result says what was capped." },
] as const;
type ItemId = (typeof ITEMS)[number]["id"];

/* 1. TASK.md and LOG.md (PR #83) */

interface Step { n: number; text: string; status: "open" | "claimed" | "done" | "blocked"; owner?: number; result?: string }
const STEPS: Step[] = [
  { n: 1, text: "add the limiter to src/api/client.ts", status: "claimed", owner: 1 },
  { n: 2, text: "document the limits in README.md", status: "open" },
  { n: 3, text: "a test for the 429 path", status: "open" },
];
const LOG = ['14:30 #1 started #2 "docs": document the limits in README.md', "14:30 #1 claimed step 1"];
const stepLine = (s: Step) => `${s.n}. [${s.status}${s.owner !== undefined && s.status !== "open" ? ` #${s.owner}` : ""}] ${s.text}${s.result ? ` — ${s.result}` : ""}`;

type Move = { by: number; action: "claim" | "done"; step: number; text?: string };
const MOVES: Move[] = [
  { by: 2, action: "claim", step: 2 },
  { by: 1, action: "claim", step: 2 },
  { by: 2, action: "done", step: 2, text: "README has a Limits section" },
  { by: 1, action: "done", step: 1, text: "429s back off for Retry-After" },
];

function Team() {
  const [steps, setSteps] = useState(STEPS);
  const [log, setLog] = useState(LOG);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [clock, setClock] = useState(31);

  const apply = (m: Move) => {
    const step = steps.find((s) => s.n === m.step)!;
    let err = "";
    if (m.action === "claim" && step.status === "done") err = `step ${step.n} is done`;
    else if (m.action === "claim" && step.owner !== undefined && step.owner !== m.by && step.status !== "open") err = `step ${step.n} is #${step.owner}'s; message it instead of taking it over`;
    else if (m.action === "done" && step.owner !== undefined && step.owner !== m.by) err = `step ${step.n} is #${step.owner}'s; only it marks it`;
    if (err) return setSaid({ ok: false, text: err });
    const next: Step = m.action === "claim" ? { ...step, status: "claimed", owner: m.by } : { ...step, status: "done", owner: m.by, result: m.text };
    setSteps(steps.map((s) => (s.n === m.step ? next : s)));
    const t = `14:${String(clock).padStart(2, "0")}`;
    setClock((c) => c + 1);
    setLog([...log, `${t} #${m.by} ${m.action === "claim" ? `claimed step ${m.step}` : `finished step ${m.step}: ${m.text}`}`].slice(-5));
    setSaid({ ok: true, text: `step ${m.step} ${m.action === "claim" ? "claimed" : "done"}` });
  };
  const reset = () => { setSteps(STEPS); setLog(LOG); setSaid(null); setClock(31); };

  return (
    <div className="sc-log">
      <div className="sc-tools" role="group" aria-label="Agents update the plan">
        {MOVES.map((m) => (
          <button key={`${m.by}${m.action}${m.step}`} type="button" onClick={() => apply(m)}>#{m.by} task_update {m.action} {m.step}</button>
        ))}
        <button type="button" onClick={reset}>Reset</button>
      </div>
      <div className="hl-files">
        <pre className="hl-file" aria-label="TASK.md"><span className="sc-h">TASK.md</span>{`# Run r1\n\nGoal (the user's words): add rate limiting to the API and document it\n\n## Plan\n${steps.map(stepLine).join("\n")}`}</pre>
        <pre className="hl-file" aria-label="LOG.md" aria-live="polite"><span className="sc-h">LOG.md</span>{log.join("\n")}</pre>
      </div>
      {said && (said.ok ? <L g="✓" c="ok">{said.text}</L> : <L g="✗" c="bad">{said.text}</L>)}
      <p className="sc-note">Only task_update changes the plan. At each turn an agent is shown, as data, what the others in its run did since it last looked.</p>
    </div>
  );
}

/* 2. @N and runs (PR #82) */

const AGENTS = [
  { id: 1, label: "api", status: "running", task: "add rate limiting" },
  { id: 2, label: "web", status: "idle", task: "fix the empty state" },
  { id: 3, label: "docs", status: "running", task: "document the limits" },
];

function Runs() {
  const [picker, setPicker] = useState(false);
  const [to, setTo] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);

  const pick = (id: number) => { setTo(id); setPicker(false); };
  const send = () => {
    const a = AGENTS.find((x) => x.id === to);
    if (!a) return;
    setNotice({ ok: true, text: `Sent to #${a.id} ${a.label} as your prompt${a.status === "running" && !stopped ? "; it reads it when it finishes what it is doing" : ""}.` });
    setTo(null);
  };
  const guard = () => setNotice({ ok: false, text: "Not sent to #1: #1 is earlier in this chain of messages and asked you nothing; answer the agent that messaged you instead." });
  const r = () => (stopping ? (setStopped(true), setStopping(false)) : setStopping(true));

  return (
    <div className="sc-log">
      <p className="sc-h">family of api · run r3: 3 agents · 7/40 messages · $0.31 woken{stopped ? " · stopped" : ""} · @N in a prompt talks to #N</p>
      <ul className="hl-agents" aria-label="Agents in run r3">
        {AGENTS.map((a) => (
          <li key={a.id}><b>#{a.id}</b> {a.label} <em className={stopped && a.status === "running" ? "bad" : a.status}>{stopped && a.status === "running" ? "stopped" : a.status}</em> <span className="mut">{a.task}</span></li>
        ))}
      </ul>
      <L g="✉" c="mem">#1 → #2 → #3: the goal travels with every message, quoted as context</L>
      <div className="hl-prompt">
        <span aria-hidden="true">▊</span>
        <button type="button" aria-expanded={picker} onClick={() => setPicker((v) => !v)}>{to ? `@${to}` : "@"}</button>
        <span>{to ? " also check the README links" : " type @ to pick an agent"}</span>
        <button type="button" disabled={!to} onClick={send}>enter</button>
      </div>
      {picker && (
        <div className="hl-pick" role="listbox" aria-label="Agents">
          {AGENTS.map((a) => <button key={a.id} type="button" role="option" aria-selected={to === a.id} onClick={() => pick(a.id)}>#{a.id} {a.label} <em>{a.status}</em></button>)}
        </div>
      )}
      {notice && (notice.ok ? <L g="✓" c="ok">{notice.text}</L> : <L g="✗" c="bad">{notice.text}</L>)}
      <div className="sc-tools">
        <button type="button" onClick={guard}>#3 message_agent #1</button>
        <button type="button" aria-pressed={stopping || stopped} disabled={stopped} onClick={r}><kbd>r</kbd>{stopping ? "again" : "stop run"}</button>
      </div>
      {stopping && <p className="sc-note">r again stops run r3: every agent it set going · any other key keeps it</p>}
      {stopped && <p className="sc-note">Run r3 stopped. Nothing in it can send again; your next prompt starts r4.</p>}
    </div>
  );
}

/* 3. Saved sub-agents (PR #81) */

const SESSION = "2026-10-21T14-30-00-000Z_8c1f";
const FILES = [
  { id: "conv", name: `${SESSION}.jsonl`, what: "your conversation", body: `{"type":"session","id":"8c1f…","cwd":"/home/you/shop"}\n{"type":"message","role":"user","content":"add rate limiting to the API"}\n…` },
  { id: "sub", name: `${SESSION}/sub/…_d41a.jsonl`, what: "sub-agent #2, any depth", body: `{"type":"session","id":"d41a…","parentSession":"…/${SESSION}.jsonl"}\n{"type":"message","role":"user","content":"map where requests are sent"}\n…` },
  { id: "state", name: `${SESSION}.state.json`, what: "every agent it started", body: `{\n  "version": 1,\n  "pid": 48213,\n  "mode": "default",\n  "model": "anthropic/claude-sonnet-4-5",\n  "status": "idle",\n  "nodes": [\n    { "id": 1, "kind": "root", "label": "api", "status": "idle" },\n    { "id": 2, "kind": "sub", "parent": 1, "label": "map requests",\n      "status": "done", "model": "anthropic/claude-haiku-4-5",\n      "caps": { "turns": 60 }, "turns": 4, "spent": 0.021,\n      "answer": "Every request goes through getJson in src/fetch.ts.",\n      "transcript": "…/sub/…_d41a.jsonl" }\n  ]\n}` },
] as const;

function Saved() {
  const [cur, setCur] = useState<(typeof FILES)[number]["id"]>("state");
  const f = FILES.find((x) => x.id === cur)!;
  return (
    <div className="sc-log">
      <p className="sc-h">~/.mnemo/agent/sessions/--home-you-shop--/</p>
      <ul className="hl-tree" aria-label="Files a saved conversation keeps">
        {FILES.map((x) => (
          <li key={x.id}><button type="button" aria-pressed={cur === x.id} onClick={() => setCur(x.id)}>{x.name} <em>{x.what}</em></button></li>
        ))}
      </ul>
      <pre className="hl-file" aria-live="polite">{f.body}</pre>
      <L g="●" c="tool">SubagentStop hook <i>status done · turns 4 · spent 0.021</i></L>
      <p className="sc-note">/resume lists only conversations. Sub-agent transcripts go after 30 days (keepSubTranscripts); your conversations never do.</p>
    </div>
  );
}

/* 4. mnemo agents (PR #80) */

const LIST = `REF     STATUS   AGENT           FOLDER   SPENT   DOING
k3f9.1  running  api             ~/shop   $0.142  “add rate limiting to the API” edit src/api/client.ts
k3f9.2  running  └ map requests           $0.021  “map where requests are sent” grep fetch( src
p7q2.1  waiting  web             ~/site   $0.050  “fix the empty state” waiting for you: edit src/pages/list.tsx
x1c8.1  done     nightly         ~/shop   $0.012  “summarise yesterday's failing tests” done 12m ago · two tests fail

QUEUED (mnemo schedule)
  nightly         in 18h    ~/shop   “summarise yesterday's failing tests”`;
const SHOW = `k3f9.2  map requests  (sub-agent of k3f9.1 api, depth 1, read-only)
status   running · 3 steps · $0.0210 · started 2m ago
folder   ~/shop
model    anthropic/claude-haiku-4-5
mode     default
task     map where requests are sent
steps
  read src/api/client.ts
  read src/api/routes.ts
  grep fetch( src
process  pid 48213 · terminal · v0.1.9 · seen 1s ago`;
const CMDS = [
  { id: "list", cmd: "mnemo agents", out: LIST },
  { id: "show", cmd: "mnemo agents show k3f9.2", out: SHOW },
  { id: "tell", cmd: 'mnemo agents tell k3f9.2 "also check the error path"', out: "map requests reads it after its current step" },
  { id: "stop", cmd: "mnemo agents stop k3f9", out: "stopped api's turn" },
  { id: "a /command", cmd: "mnemo agents tell p7q2 /yolo", out: "mnemo agents: a command (/…) is typed in that agent's own terminal" },
] as const;

function Registry() {
  const [cur, setCur] = useState<(typeof CMDS)[number]["id"]>("list");
  const c = CMDS.find((x) => x.id === cur)!;
  return (
    <div className="sc-log">
      <div className="sc-tools" role="group" aria-label="Commands">
        {CMDS.map((x) => <button key={x.id} type="button" aria-pressed={cur === x.id} onClick={() => setCur(x.id)}>{x.id}</button>)}
      </div>
      <L g="$" c="you">{c.cmd}</L>
      <pre className="hl-file hl-wide" aria-live="polite">{c.out}</pre>
      <p className="sc-note">Each process keeps a file in ~/.mnemo/registry/. One that crashed shows as lost. MNEMO_REGISTRY=0 keeps a process out.</p>
    </div>
  );
}

/* 5. Sub-agent model and limits (PR #79) */

const ASKS = [
  { id: "none", label: "nothing", args: "", ran: "[ran on anthropic/claude-haiku-4-5, thinking low]", use: "claude-haiku-4-5 · 12/60 turns · $0.03/$0.50" },
  { id: "turns", label: "maxTurns 20", args: ", maxTurns: 20", ran: "[ran on anthropic/claude-haiku-4-5, thinking low]", use: "claude-haiku-4-5 · 12/20 turns · $0.03/$0.50" },
  { id: "more", label: "maxTurns 200", args: ", maxTurns: 200", ran: "[ran on anthropic/claude-haiku-4-5, thinking low; maxTurns capped at your user's subMaxTurns of 60]", use: "claude-haiku-4-5 · 12/60 turns · $0.03/$0.50" },
  { id: "budget", label: "budget 2", args: ", budget: 2", ran: "[ran on anthropic/claude-haiku-4-5, thinking low; budget capped at your user's subSpend of $0.50]", use: "claude-haiku-4-5 · 12/60 turns · $0.03/$0.50" },
  { id: "model", label: "a model you did not allow", args: ', model: "anthropic/claude-opus-4-1"', ran: "", use: "" },
] as const;

function Limits() {
  const [cur, setCur] = useState<(typeof ASKS)[number]["id"]>("more");
  const a = ASKS.find((x) => x.id === cur)!;
  return (
    <div className="sc-log">
      <pre className="hl-file"><span className="sc-h">/settings → Agents</span>{"subModel     anthropic/claude-haiku-4-5\nsubModels    anthropic/claude-haiku-*, anthropic/claude-sonnet-*\nsubThinking  low\nsubMaxTurns  60\nsubSpend     $0.50"}</pre>
      <div className="sc-tools" role="radiogroup" aria-label="What the parent asks for">
        <span className="mut">the parent asks for</span>
        {ASKS.map((x) => <button key={x.id} type="button" role="radio" aria-checked={cur === x.id} onClick={() => setCur(x.id)}>{x.label}</button>)}
      </div>
      <L g="●" c="tool">spawn_subagent <i>{`{ task: "map where requests are sent"${a.args} }`}</i></L>
      {a.ran ? (
        <>
          <L g="│" c="agent">Every request goes through getJson in src/fetch.ts. <em>{a.ran}</em></L>
          <L g="◆" c="mem">{a.use}</L>
        </>
      ) : (
        <L g="✗" c="bad">anthropic/claude-opus-4-1 is not among the models your user lets you pick (/settings subModels: anthropic/claude-haiku-*, anthropic/claude-sonnet-*)</L>
      )}
      <p className="sc-note">A parent can lower each limit for one task, never raise it past yours. The managed policy's models list still applies on top.</p>
    </div>
  );
}

export function Highlights() {
  const [cur, setCur] = useState<ItemId>(ITEMS[0].id);
  const item = ITEMS.find((s) => s.id === cur)!;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = ITEMS.findIndex((s) => s.id === cur);
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const s = ITEMS[(next + ITEMS.length) % ITEMS.length]!;
    setCur(s.id);
    document.getElementById(`hl-tab-${s.id}`)?.focus();
  };

  return (
    <section className="hl-sec" id="new" aria-labelledby="hl-h">
      <div className="wrap">
        <p className="eyebrow" data-reveal=""><span className="ribbon-tag">Just added</span></p>
        <Split id="hl-h" text="Five new things your agents can do" />
        <p className="lead-sm" data-reveal="">The newest work, newest first. Each one runs below as a small demo built from the app's own text. Pick one and press the buttons.</p>
        <div className="hl-tabs" role="tablist" aria-label="New features" onKeyDown={onKey}>
          {ITEMS.map((s, i) => (
            <button key={s.id} id={`hl-tab-${s.id}`} type="button" role="tab" className={`tone-${s.tone}`} aria-selected={s.id === cur} aria-controls="hl-panel" tabIndex={s.id === cur ? 0 : -1} onClick={() => setCur(s.id)}>
              <span className="hl-n" aria-hidden="true">№{String(i + 1).padStart(2, "0")}</span>
              <span className="adcard-tag">{s.tag}</span>
              <span className="hl-t">{s.title}</span>
              <em className="sc-soon">{s.status}</em>
            </button>
          ))}
        </div>
        <div className="hl-grid">
          <div className="hl-copy" aria-live="polite">
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            <p className="hl-pr">
              <em className="sc-soon">{item.status}</em>
              <a href={`${REPO}/pull/${item.pr}`}>Pull request #{item.pr}</a>
            </p>
            {item.status === "on main" && <p className="fine">Merged, and in the next release.</p>}
            {item.status === "in review" && <p className="fine">Not merged yet, and it may change in review.</p>}
          </div>
          <div id="hl-panel" role="tabpanel" aria-labelledby={`hl-tab-${cur}`} className="th sc-win th-night hl-win">
            <div className="sc-bar" aria-hidden="true"><i /><i /><i /><span>mnemo · ~/shop</span></div>
            <div className="sc-body" key={cur}>
              {cur === "team" && <Team />}
              {cur === "runs" && <Runs />}
              {cur === "saved" && <Saved />}
              {cur === "registry" && <Registry />}
              {cur === "limits" && <Limits />}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
