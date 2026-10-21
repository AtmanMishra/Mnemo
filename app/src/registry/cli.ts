/**
 * `mnemo agents`: every Mnemo agent on this machine, in every project, read from the registry
 * (store.ts) with no model and no sidecar; and the few things another terminal may ask of one
 * (inbox.ts). Runs from any folder.
 */
import * as os from "node:os";
import { nextRun } from "../schedule/run.ts";
import { loadJobs } from "../schedule/store.ts";
import { awaitAck, sendRequest, type Op } from "./inbox.ts";
import { senderName } from "./join.ts";
import { prune, readAll, shownStatus, validTag, type AgentEntry, type AgentStatus, type ProcView, type ReadOptions } from "./store.ts";

export const AGENTS_USAGE = `mnemo agents — every Mnemo agent on this machine, in every project

usage
  mnemo agents                      what is running, and what finished in the last hour
  mnemo agents --all                everything kept (a day of finished and lost agents)
  mnemo agents --json               the same as JSON
  mnemo agents show <ref>           everything about one agent
  mnemo agents watch                the list, redrawn every second (ctrl+c stops)
  mnemo agents tell <ref> <text>    your words: read when its current turn ends, or start a turn
  mnemo agents steer <ref> <text>   your words, read by a running agent after its current step
  mnemo agents stop <ref>           stop its turn; a sub-agent stops with everything it started
  mnemo agents clear                forget finished and lost agents

<ref> is the first column (k3f9.2: process k3f9, agent 2), or a name only one live agent has.
A process tag alone (k3f9) means its first conversation. Your words start a turn under that
terminal's mode and permission gate; approvals are answered only in the terminal that asks.
Lost means the process died without saying so (a crash, a closed terminal).`;

/** An agent with where it lives. */
export interface Row {
  view: ProcView;
  agent: AgentEntry;
  ref: string;
  status: AgentStatus;
}

const RECENT_MS = 60 * 60_000;
const ENDED = new Set<AgentStatus>(["done", "failed", "stopped", "closed", "lost"]);

export function rows(views: ProcView[], o: { all?: boolean; now?: number } = {}): Row[] {
  const now = o.now ?? Date.now();
  const out: Row[] = [];
  for (const view of views) {
    if (!o.all && view.state !== "live" && now - (view.rec.endedAt ?? view.rec.heartbeat) > RECENT_MS) continue;
    for (const agent of tree(view.rec.agents)) out.push({ view, agent, ref: `${view.rec.tag}.${agent.node}`, status: shownStatus(agent, view.state) });
  }
  return out;
}

/** Roots in order, each followed by its descendants depth-first. */
function tree(agents: AgentEntry[]): AgentEntry[] {
  const out: AgentEntry[] = [];
  const ids = new Set(agents.map((a) => a.node));
  const walk = (a: AgentEntry) => {
    out.push(a);
    for (const c of agents.filter((x) => x.parent === a.node)) walk(c);
  };
  // An orphan (its parent trimmed from the record) is shown at the top level rather than lost.
  for (const a of agents.filter((x) => x.parent === undefined || !ids.has(x.parent))) walk(a);
  return out;
}

export function resolve(all: Row[], ref: string): Row | string {
  const m = /^([a-z0-9]{4,12})(?:\.(\d+))?$/.exec(ref.trim().toLowerCase());
  if (m && validTag(m[1]!)) {
    const inProc = all.filter((r) => r.view.rec.tag === m[1]);
    if (inProc.length) {
      if (m[2] === undefined) return inProc.find((r) => r.agent.kind === "root" && !ENDED.has(r.status)) ?? inProc.find((r) => r.agent.kind === "root") ?? inProc[0]!;
      return inProc.find((r) => r.agent.node === Number(m[2])) ?? `process ${m[1]} has no agent ${m[2]}`;
    }
  }
  const named = all.filter((r) => r.agent.label.toLowerCase() === ref.trim().toLowerCase());
  const live = named.filter((r) => !ENDED.has(r.status));
  if (live.length === 1) return live[0]!;
  if (live.length > 1) return `${live.length} live agents are called ${ref}: ${live.map((r) => r.ref).join(", ")}`;
  if (named.length === 1) return named[0]!;
  return `no agent ${ref} (mnemo agents lists them)`;
}

const tilde = (p: string | undefined) => {
  if (!p) return "";
  const h = os.homedir();
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
};
const clip = (s: string, n: number) => (n <= 1 ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pad = (s: string, n: number) => clip(s, n).padEnd(n);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** What it is doing now, or how it ended. */
function doing(r: Row, now: number): string {
  const a = r.agent;
  if (a.waiting && !ENDED.has(r.status)) return `waiting for you: ${a.waiting}`;
  if (r.status === "running") return a.steps.at(-1) ?? "thinking";
  if (ENDED.has(r.status)) return `${r.status} ${ago(now - (a.endedAt ?? r.view.rec.heartbeat))} ago${a.answer ? ` · ${oneLine(a.answer)}` : ""}`;
  return a.pending ? `${a.pending} message${a.pending === 1 ? "" : "s"} held for you` : "";
}

export interface QueuedJob {
  name: string;
  cwd: string;
  prompt: string;
  next?: number;
}

export function queuedJobs(home: string): QueuedJob[] {
  return loadJobs(home)
    .filter((j) => j.enabled)
    .map((j) => ({ name: j.name, cwd: j.cwd, prompt: j.prompt, next: nextRun(j)?.getTime() }));
}

export function renderList(all: Row[], jobs: QueuedJob[], o: { width?: number; now?: number } = {}): string {
  const now = o.now ?? Date.now();
  const w = Math.max(60, o.width ?? 100);
  if (!all.length && !jobs.length) return "No Mnemo agents are running, and none finished in the last hour (--all shows the last day).";
  const lines: string[] = [];
  const refW = Math.max(6, ...all.map((r) => r.ref.length)) + 1;
  const nameW = Math.min(24, Math.max(8, ...all.map((r) => r.agent.label.length + r.agent.depth * 2)) + 1);
  const dirW = Math.min(28, Math.max(8, ...all.map((r) => tilde(r.agent.cwd).length)) + 1);
  const rest = w - refW - 9 - nameW - dirW - 8;
  if (all.length) lines.push(`${pad("REF", refW)}${pad("STATUS", 9)}${pad("AGENT", nameW)}${pad("FOLDER", dirW)}${pad("SPENT", 8)}DOING`);
  for (const r of all) {
    const a = r.agent;
    const name = `${a.depth ? `${"  ".repeat(a.depth - 1)}└ ` : ""}${a.label}`;
    const task = a.task ? `“${oneLine(a.task)}” ` : "";
    const status = a.waiting && !ENDED.has(r.status) ? "waiting" : r.status;
    lines.push(`${pad(r.ref, refW)}${pad(status, 9)}${pad(name, nameW)}${pad(a.depth ? "" : tilde(a.cwd), dirW)}${pad(a.spent > 0 ? `$${a.spent.toFixed(3)}` : "", 8)}${clip(`${task}${doing(r, now)}`, rest)}`);
  }
  if (jobs.length) {
    if (lines.length) lines.push("");
    lines.push("QUEUED (mnemo schedule)");
    for (const j of jobs) lines.push(`  ${pad(j.name, 16)}${pad(j.next ? `in ${ago(j.next - now)}` : "never", 10)}${pad(tilde(j.cwd), dirW)}${clip(`“${oneLine(j.prompt)}”`, w - 28 - dirW)}`);
  }
  return lines.join("\n");
}

export function renderShow(r: Row, all: Row[], now = Date.now()): string {
  const a = r.agent;
  const rec = r.view.rec;
  const parent = a.parent !== undefined ? all.find((x) => x.view === r.view && x.agent.node === a.parent) : undefined;
  const kids = all.filter((x) => x.view === r.view && x.agent.parent === a.node);
  const out: string[] = [];
  const line = (k: string, v: string | undefined) => v && out.push(`${k.padEnd(9)}${v}`);
  out.push(`${r.ref}  ${a.label}  ${a.kind === "root" ? "(conversation)" : `(sub-agent of ${parent ? `${parent.ref} ${parent.agent.label}` : `#${a.parent}`}, depth ${a.depth}${a.access === "read-only" ? ", read-only" : ""})`}`);
  line("status", [r.status, a.waiting && !ENDED.has(r.status) ? `waiting for you: ${a.waiting}` : "", `${a.stepCount} step${a.stepCount === 1 ? "" : "s"}`, a.spent > 0 ? `$${a.spent.toFixed(4)}` : "", `started ${ago(now - a.startedAt)} ago`, a.endedAt ? `ended ${ago(now - a.endedAt)} ago` : ""].filter(Boolean).join(" · "));
  line("folder", tilde(a.cwd));
  line("model", a.model);
  line("mode", a.mode);
  line("held", a.pending ? `${a.pending} message${a.pending === 1 ? "" : "s"} for its user's next prompt` : undefined);
  line("task", a.task ? oneLine(a.task) : undefined);
  if (a.steps.length) {
    out.push("steps");
    for (const s of a.steps) out.push(`  ${s}`);
  }
  line("answer", a.answer);
  if (kids.length) {
    out.push("started");
    for (const k of kids) out.push(`  ${k.ref.padEnd(10)}${k.status.padEnd(9)}${k.agent.label}`);
  }
  line("session", tilde(a.session));
  line("process", `pid ${rec.pid} · ${rec.kind === "print" ? "headless (mnemo -p)" : rec.kind === "rpc" ? "editor (--rpc)" : "terminal"} · v${rec.version} · ${r.view.state === "live" ? `seen ${ago(now - rec.heartbeat)} ago` : r.view.state === "ended" ? `exited ${ago(now - (rec.endedAt ?? 0))} ago` : `lost: last seen ${ago(now - rec.heartbeat)} ago`}`);
  return out.join("\n");
}

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  width?: number;
  cwd?: string;
  /** How long `tell`/`steer`/`stop` wait for the process to answer. */
  ackMs?: number;
  read?: ReadOptions;
}

const defaultIo = (): CliIo => ({ out: (s) => console.log(s), err: (s) => console.error(s), width: process.stdout.columns, cwd: process.cwd() });

export async function agentsCommand(argv: string[], home: string, io: CliIo = defaultIo()): Promise<number> {
  const fail = (msg: string, code = 1) => (io.err(`mnemo agents: ${msg}`), code);
  // The words of tell and steer are taken as typed, a "--" in them included.
  const at = argv.findIndex((a) => a === "tell" || a === "steer");
  const head = at >= 0 && argv.slice(0, at).every((a) => a.startsWith("--")) ? argv.slice(0, at + 2) : argv;
  const words = head === argv ? [] : argv.slice(at + 2);
  const flags = new Set(head.filter((a) => a.startsWith("--")));
  const pos = [...head.filter((a) => !a.startsWith("--")), ...words];
  const unknown = [...flags].find((f) => !["--all", "--json", "--help"].includes(f));
  if (unknown) return fail(`unknown option ${unknown}\n${AGENTS_USAGE}`, 2);
  const [sub, ...rest] = pos;
  if (flags.has("--help") || sub === "help") return io.out(AGENTS_USAGE), 0;
  const all = flags.has("--all");
  const now = () => io.read?.now ?? Date.now();
  const load = () => rows(readAll(home, io.read), { all: true, now: now() });

  if (sub === undefined || sub === "list") {
    if (rest.length) return fail(`list takes no arguments\n${AGENTS_USAGE}`, 2);
    const views = readAll(home, io.read);
    const jobs = queuedJobs(home);
    if (flags.has("--json")) {
      const shown = new Set(rows(views, { all, now: now() }).map((r) => r.view));
      io.out(JSON.stringify({ procs: views.filter((v) => shown.has(v)).map((v) => ({ ...v.rec, state: v.state, agents: v.rec.agents.map((a) => ({ ...a, status: shownStatus(a, v.state) })) })), queued: jobs }, null, 2));
      return 0;
    }
    io.out(renderList(rows(views, { all, now: now() }), jobs, { width: io.width, now: now() }));
    return 0;
  }
  if (sub === "watch") {
    if (rest.length) return fail("watch takes no arguments", 2);
    const stop = new AbortController();
    process.once("SIGINT", () => stop.abort());
    while (!stop.signal.aborted) {
      io.out(`\x1b[H\x1b[2J${renderList(rows(readAll(home, io.read), { all, now: Date.now() }), queuedJobs(home), { width: process.stdout.columns, now: Date.now() })}\n\n(ctrl+c stops)`);
      await Bun.sleep(1000);
    }
    return 0;
  }
  if (sub === "clear") {
    if (rest.length) return fail("clear takes no arguments", 2);
    const n = prune(home, { ...io.read, all: true });
    io.out(n ? `forgot ${n} finished or lost process${n === 1 ? "" : "es"}` : "nothing to forget");
    return 0;
  }
  if (sub === "show") {
    if (rest.length !== 1) return fail("show needs one <ref>", 2);
    const list = load();
    const r = resolve(list, rest[0]!);
    if (typeof r === "string") return fail(r);
    if (flags.has("--json")) return io.out(JSON.stringify({ ...r.agent, status: r.status, ref: r.ref, process: { tag: r.view.rec.tag, pid: r.view.rec.pid, kind: r.view.rec.kind, state: r.view.state } }, null, 2)), 0;
    io.out(renderShow(r, list, now()));
    return 0;
  }
  if (sub === "tell" || sub === "steer" || sub === "stop") {
    const op: Op = sub;
    const [ref, ...words] = rest;
    if (!ref) return fail(`${op} needs a <ref>`, 2);
    const text = words.join(" ").trim();
    if (op !== "stop" && !text) return fail(`${op} needs the words to send: mnemo agents ${op} ${ref} "…"`, 2);
    if (op === "stop" && text) return fail("stop takes only a <ref>", 2);
    const r = resolve(load(), ref);
    if (typeof r === "string") return fail(r);
    if (r.view.state !== "live") return fail(`${r.ref} ${r.agent.label} is not running (its process ${r.view.state === "ended" ? "has exited" : "was lost"})`);
    if (ENDED.has(r.status)) return fail(`${r.ref} ${r.agent.label} has ${r.status === "closed" ? "closed" : "finished"}`);
    let id: string;
    try {
      id = sendRequest(home, r.view.rec.tag, { op, node: r.agent.node, text: text || undefined, from: io.cwd ? senderName(io.cwd) : undefined });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    const ack = await awaitAck(home, id, io.ackMs ?? 5000);
    if (!ack) {
      io.out(`sent to ${r.ref} ${r.agent.label}; its process has not picked it up yet and will when it can`);
      return 0;
    }
    if (!ack.ok) return fail(ack.result);
    io.out(ack.result);
    return 0;
  }
  return fail(`unknown command ${sub}\n${AGENTS_USAGE}`, 2);
}

/**
 * For the hub: what other processes are running now, and what was lost in the last hour (a
 * crash shows rather than vanishing). This process (`self`) is the hub's own cards.
 */
export function elsewhere(home: string, self: string | undefined, o: ReadOptions = {}): Row[] {
  return rows(readAll(home, o), { now: o.now }).filter((r) => r.view.rec.tag !== self && (r.view.state === "live" ? !ENDED.has(r.status) : r.status === "lost"));
}
