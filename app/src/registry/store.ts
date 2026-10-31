/**
 * The agent registry: every Mnemo process on this machine, whatever project it runs in, and
 * the agents it runs. Plain files under `$MNEMO_HOME/registry/`, so any process (or a person
 * with `cat`) can read them and no index can drift from them:
 *
 *   procs/<tag>.json      one per process, rewritten as its roster changes and every few seconds
 *                         as a heartbeat; kept after a clean exit so finished work still shows
 *   inbox/<tag>/<id>.json requests to that process from another terminal (inbox.ts)
 *   acks/<id>.json        the owner's answer to one request
 *
 * There is no socket and no server: control is a file the owning process picks up. Folders are
 * 0700 and files 0600, so only the same OS user reads or writes them. A file is written next
 * to its final name and renamed into place, so a reader never sees half of one.
 *
 * A process that died without saying so (a crash, a kill, a closed terminal) still has its
 * file: it reads as `lost` once its pid is gone or its heartbeat is old.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Access, NodeKind, NodeStatus } from "../runtime/roster.ts";

/** A node's status, plus `closed` (a conversation the user closed) and `lost` (its process died). */
export type AgentStatus = NodeStatus | "closed" | "lost";
export type ProcKind = "interactive" | "print" | "rpc";

export interface AgentEntry {
  /** The node's id in its own process's roster. */
  node: number;
  parent?: number;
  kind: NodeKind;
  label: string;
  task: string;
  depth: number;
  access: Access;
  status: Exclude<AgentStatus, "lost">;
  /** The project folder (a sub-agent works in its root's). */
  cwd?: string;
  model?: string;
  /** A sub-agent's thinking level and limits (0 for turns or spend is no limit), and the model calls it made. */
  thinking?: string;
  caps?: { turns: number; spend: number; maxTokens: number; context: number };
  turns?: number;
  mode?: string;
  /** What it is waiting for the user to answer, in that terminal ("approve bash"). */
  waiting?: string;
  steps: string[];
  stepCount: number;
  answer?: string;
  startedAt: number;
  endedAt?: number;
  spent: number;
  /** Messages held for its user's next prompt. */
  pending: number;
  /** The transcript file, when the session has one. */
  session?: string;
}

export interface ProcRecord {
  v: 1;
  tag: string;
  pid: number;
  kind: ProcKind;
  version: string;
  startedAt: number;
  heartbeat: number;
  /** Set when the process ended cleanly. */
  endedAt?: number;
  agents: AgentEntry[];
}

/** A record as a reader sees it: `live`, `ended` (exited cleanly) or `lost` (died, or stopped answering). */
export interface ProcView {
  rec: ProcRecord;
  state: "live" | "ended" | "lost";
}

/** A heartbeat this old means the process is gone even if its pid was reused. */
export const STALE_MS = 90_000;
export const HEARTBEAT_MS = 5_000;
/** Ended and lost records are kept this long, and at most `KEEP_ENDED` of them. */
export const KEEP_MS = 24 * 60 * 60_000;
export const KEEP_ENDED = 50;
/** An answer nobody collected. */
export const ACK_MS = 10 * 60_000;

export const registryDir = (home: string) => path.join(home, "registry");
export const procsDir = (home: string) => path.join(registryDir(home), "procs");
export const procFile = (home: string, tag: string) => path.join(procsDir(home), `${tag}.json`);
export const inboxDir = (home: string, tag: string) => path.join(registryDir(home), "inbox", tag);
export const acksDir = (home: string) => path.join(registryDir(home), "acks");

const TAG = /^[a-z0-9]{4,12}$/;
export const validTag = (s: string) => TAG.test(s);

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Windows refuses a rename over a file another process has open for a moment (a reader): try again shortly. */
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

function rename(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (i >= 8 || !BUSY.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      Bun.sleepSync(5 * (i + 1));
    }
  }
}

/** Write `data` as JSON to `file` whole or not at all. False when it could not be written (a full disk). */
export function writeJson(file: string, data: unknown): boolean {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    rename(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* its folder is not there either */
    }
    return false;
  }
}

export function readJson(file: string): unknown {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      // A writer renaming over it on Windows: once more.
      if (i < 3 && BUSY.has((e as NodeJS.ErrnoException).code ?? "")) {
        Bun.sleepSync(5);
        continue;
      }
      return undefined;
    }
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const STATUSES = new Set(["idle", "running", "done", "failed", "stopped", "closed"]);

/** A record from disk, or undefined when it is not one (a stray file, an older or newer format). */
export function parseRecord(raw: unknown): ProcRecord | undefined {
  const r = raw as Partial<ProcRecord> | undefined;
  if (!r || r.v !== 1 || typeof r.tag !== "string" || !validTag(r.tag) || !num(r.pid) || !Array.isArray(r.agents)) return undefined;
  if (r.kind !== "interactive" && r.kind !== "print" && r.kind !== "rpc") return undefined;
  const agents: AgentEntry[] = [];
  for (const a of r.agents.slice(0, 200) as Partial<AgentEntry>[]) {
    if (!a || !num(a.node) || (a.kind !== "root" && a.kind !== "sub") || !STATUSES.has(String(a.status))) continue;
    agents.push({
      node: a.node!,
      parent: num(a.parent),
      kind: a.kind,
      label: str(a.label, 80) ?? "",
      task: str(a.task, 400) ?? "",
      depth: num(a.depth) ?? 0,
      access: a.access === "read-only" ? "read-only" : "full",
      status: a.status as AgentEntry["status"],
      cwd: str(a.cwd, 4096),
      model: str(a.model, 200),
      thinking: str(a.thinking, 20),
      caps: a.caps && typeof a.caps === "object" ? { turns: num(a.caps.turns) ?? 0, spend: num(a.caps.spend) ?? 0, maxTokens: num(a.caps.maxTokens) ?? 0, context: num(a.caps.context) ?? 0 } : undefined,
      turns: num(a.turns),
      mode: str(a.mode, 40),
      waiting: str(a.waiting, 120),
      steps: Array.isArray(a.steps) ? a.steps.filter((s): s is string => typeof s === "string").slice(-20) : [],
      stepCount: num(a.stepCount) ?? 0,
      answer: str(a.answer, 1500),
      startedAt: num(a.startedAt) ?? 0,
      endedAt: num(a.endedAt),
      spent: num(a.spent) ?? 0,
      pending: num(a.pending) ?? 0,
      session: str(a.session, 4096),
    });
  }
  return { v: 1, tag: r.tag, pid: r.pid!, kind: r.kind, version: str(r.version, 40) ?? "", startedAt: num(r.startedAt) ?? 0, heartbeat: num(r.heartbeat) ?? 0, endedAt: num(r.endedAt), agents };
}

/** Whether a process with this pid exists (EPERM: it does, as another user). */
export function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ReadOptions {
  now?: number;
  alive?: (pid: number) => boolean;
}

export function stateOf(rec: ProcRecord, o: ReadOptions = {}): ProcView["state"] {
  if (rec.endedAt !== undefined) return "ended";
  const now = o.now ?? Date.now();
  return now - rec.heartbeat > STALE_MS || !(o.alive ?? pidAlive)(rec.pid) ? "lost" : "live";
}

/** The status an agent shows: one that was working when its process died is `lost`. */
export function shownStatus(a: AgentEntry, state: ProcView["state"]): AgentStatus {
  if (state !== "lost") return a.status;
  return a.status === "running" || a.status === "idle" ? "lost" : a.status;
}

/** Every record, newest first. */
export function readAll(home: string, o: ReadOptions = {}): ProcView[] {
  let names: string[];
  try {
    names = fs.readdirSync(procsDir(home));
  } catch {
    return [];
  }
  const out: ProcView[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const rec = parseRecord(readJson(path.join(procsDir(home), name)));
    if (rec && `${rec.tag}.json` === name) out.push({ rec, state: stateOf(rec, o) });
  }
  return out.sort((a, b) => b.rec.startedAt - a.rec.startedAt);
}

/** A tag no record has: four letters and digits, taken by creating the file. */
export function claimTag(home: string, write: (tag: string) => string): string {
  ensureDir(procsDir(home));
  for (let i = 0; ; i++) {
    const tag = Array.from({ length: i < 50 ? 4 : 8 }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join("");
    try {
      fs.writeFileSync(procFile(home, tag), write(tag), { flag: "wx", mode: 0o600 });
      return tag;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || i > 200) throw e;
    }
  }
}

/**
 * Forget what is old: ended and lost records past `KEEP_MS` or beyond the newest `KEEP_ENDED`,
 * the inboxes of processes that are not running, answers nobody collected and half-written files. A live record
 * is never touched. `all` forgets every ended and lost record now (`mnemo agents clear`).
 */
export function prune(home: string, o: ReadOptions & { all?: boolean } = {}): number {
  const now = o.now ?? Date.now();
  const views = readAll(home, o);
  const live = new Set(views.filter((v) => v.state === "live").map((v) => v.rec.tag));
  const gone = views.filter((v) => v.state !== "live");
  let removed = 0;
  gone.forEach((v, i) => {
    const at = v.rec.endedAt ?? v.rec.heartbeat;
    if (o.all || i >= KEEP_ENDED || now - at > KEEP_MS) {
      fs.rmSync(procFile(home, v.rec.tag), { force: true });
      removed++;
    }
  });
  try {
    for (const tag of fs.readdirSync(path.join(registryDir(home), "inbox"))) if (!live.has(tag)) fs.rmSync(inboxDir(home, tag), { recursive: true, force: true });
  } catch {
    /* no inboxes */
  }
  // Half-written files of a process that died mid-write.
  try {
    for (const name of fs.readdirSync(procsDir(home))) {
      if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
      const st = fs.statSync(path.join(procsDir(home), name), { throwIfNoEntry: false });
      if (st && now - st.mtimeMs > ACK_MS) fs.rmSync(path.join(procsDir(home), name), { force: true });
    }
  } catch {
    /* no records */
  }
  try {
    for (const name of fs.readdirSync(acksDir(home))) {
      const file = path.join(acksDir(home), name);
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (st && now - st.mtimeMs > ACK_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    /* no answers */
  }
  return removed;
}
