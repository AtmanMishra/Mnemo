/**
 * AREA 9.6 — hooks in memory.
 *
 * Each effective hook is indexed as a Procedural node (kind "harness" like
 * the harness-indexing path, so procedural recall finds it) with label
 * `hook:<id>` and facts: role=hook, trigger, matcher, scope, location and
 * description. A `role: hook` fact keeps hook nodes unambiguous next to real
 * harness bundles. Idempotent: re-syncing never duplicates a node — identity
 * is (label, location), same rule as findHarnessNode.
 *
 * The index functions take an injected `request(method, params)` client so
 * tests use the fake-client pattern; the compact memsrv client below is what
 * the extension uses in production. All root/state paths are injected; a dead
 * sidecar must never break the session that asked to sync.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hook } from "./types.ts";
import { scrubChildEnv } from "../childenv.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_BINARY = path.join(REPO_ROOT, "memory-layer", "target", "debug", "memsrv");
const DEFAULT_JOURNAL = path.join(REPO_ROOT, "memory-layer", "data", "sea-agent-journal.jsonl");

export interface MemClientLike {
  request(method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }>;
}

// --- compact memsrv client (protocol per HANDOFF §5) -------------------------

interface Pending { resolve: (r: { ok: boolean; result?: any; error?: string }) => void }

export class HookMemsrvClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private queue: Promise<unknown> = Promise.resolve();
  private readonly binaryPath: string;
  private readonly journalPath: string;

  constructor(opts: { binaryPath?: string; journalPath?: string } = {}) {
    this.binaryPath = opts.binaryPath ?? process.env.MNEMO_MEMSRV_BIN ?? DEFAULT_BINARY;
    this.journalPath = opts.journalPath ?? process.env.MNEMO_MEMORY_JOURNAL ?? DEFAULT_JOURNAL;
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string }> {
    const task = this.queue.then(async () => {
      try {
        this.start();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
      return await this.requestImmediate(method, params);
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  stop(): void {
    const old = this.proc;
    this.proc = null;
    this.pending.clear();
    if (!old) return;
    try { old.stdin?.write(JSON.stringify({ method: "exit" }) + "\n"); } catch { /* gone */ }
    setTimeout(() => {
      if (old.exitCode === null) {
        old.removeAllListeners("exit");
        old.kill("SIGKILL");
      }
    }, 250).unref?.();
  }

  private start(): void {
    if (this.alive) return;
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`memsrv binary not found at ${this.binaryPath} (build with cargo build --bin memsrv)`);
    }
    // deterministic hashing embedder unless remote is opted in, like the
    // memory-layer extension does. 12.7: scrub ALL credential-shaped vars
    // (not just OPENROUTER) — remote mode re-adds exactly the one it needs.
    const remote = process.env.MNEMO_MEMORY_REMOTE === "1" || process.env.SEA_MEMORY_REMOTE === "1";
    const env: NodeJS.ProcessEnv = scrubChildEnv();
    if (remote && process.env.OPENROUTER_API_KEY) {
      env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    }

    const proc = spawn(this.binaryPath, [this.journalPath], { cwd: REPO_ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.buffer = "";
    proc.stdout?.on("data", (c: Buffer) => this.handleChunk(c));
    proc.once("exit", () => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const [, p] of [...this.pending]) p.resolve({ ok: false, error: "memsrv exited before responding" });
      this.pending.clear();
    });
    proc.once("error", (err) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const [, p] of [...this.pending]) p.resolve({ ok: false, error: String(err) });
      this.pending.clear();
    });
    process.once("exit", () => this.stop());
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error ?? "memsrv error" });
      }
    }
  }

  private requestImmediate(method: string, params: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }> {
    const id = this.nextId++;
    const stdin = this.proc?.stdin ?? null;
    if (!this.proc || !stdin) return Promise.resolve({ ok: false, error: "memsrv is not running" });
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      try { stdin.write(JSON.stringify({ id, method, params }) + "\n"); }
      catch (err) {
        this.pending.delete(id);
        resolve({ ok: false, error: `memsrv stdin write failed: ${String(err)}` });
      }
    });
  }
}

// --- index shape -------------------------------------------------------------

export interface HookIndexInput {
  id: string;
  description?: string;
  trigger: string;
  matcher?: string;
  scope: string;
  location: string;
}

export function indexInputFor(hook: Hook): HookIndexInput {
  return {
    id: hook.id,
    description: hook.description,
    trigger: hook.trigger,
    matcher: [hook.matcher?.tool && `tool=${hook.matcher.tool}`, hook.matcher?.path && `path=${hook.matcher.path}`]
      .filter(Boolean).join(" ") || undefined,
    scope: hook.scope ?? "",
    location: hook.file ?? "",
  };
}

interface DumpedNode { id: number; kind: string; area: string; label: string }

/** Facts from memsrv `state` render as `  - key: value` lines. */
export function factsFromState(state: string): Map<string, string> {
  const facts = new Map<string, string>();
  for (const line of state.split("\n")) {
    const m = line.match(/^\s*-\s*([^:]+):\s?(.*)$/);
    if (m) facts.set(m[1].trim(), m[2].trim());
  }
  return facts;
}

/**
 * Identity lookup: a node with kind Harness, exact label `hook:<id>` and —
 * when the hook has a location — an exactly matching location fact. A
 * name-only node from before locations were recorded matches on label alone.
 */
export async function findHookNode(client: MemClientLike, input: HookIndexInput): Promise<number | null> {
  let dump;
  try { dump = await client.request("dump"); } catch { return null; }
  if (!dump.ok) return null;
  const nodes = (dump.result?.nodes ?? []) as DumpedNode[];
  for (const n of nodes) {
    if (n.kind !== "Harness" || n.label !== `hook:${input.id}`) continue;
    if (!input.location) return n.id;
    let stateRes;
    try { stateRes = await client.request("state", { node: n.id }); } catch { continue; }
    if (!stateRes.ok) continue;
    const loc = factsFromState(String(stateRes.result?.state ?? "")).get("location");
    if (loc === input.location || loc === undefined) return n.id;
  }
  return null;
}

/** Idempotent index of one hook; failures are reported, never thrown. */
export async function ensureHookIndexed(
  client: MemClientLike,
  input: HookIndexInput,
): Promise<{ ok: true; node: number; existed: boolean } | { ok: false; error: string }> {
  const existing = await findHookNode(client, input);
  if (existing !== null) return { ok: true, node: existing, existed: true };
  try {
    const created = await client.request("create_node", {
      kind: "harness", area: "procedural", label: `hook:${input.id}`,
    });
    if (!created.ok) return { ok: false, error: created.error ?? "create_node failed" };
    const node = Number(created.result?.node);
    const facts: Array<[string, string]> = [
      ["role", "hook"],
      ["trigger", input.trigger],
      ...(input.matcher ? [["matcher", input.matcher] as [string, string]] : []),
      ["scope", input.scope],
    ];
    if (input.description) facts.push(["description", input.description]);
    if (input.location) facts.push(["location", input.location]);
    for (const [key, value] of facts) {
      const f = await client.request("fact", { node, key, value });
      if (!f.ok) return { ok: false, error: `fact ${key}: ${f.error}` };
    }
    return { ok: true, node, existed: false };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export interface SyncCounts {
  created: number;
  existing: number;
  failed: string[];
}

/** One sync pass over the effective hook list, best-effort per hook. */
export async function indexHooksToMemory(
  client: MemClientLike,
  hooks: Hook[],
  log: (line: string) => void = () => {},
): Promise<SyncCounts> {
  const out: SyncCounts = { created: 0, existing: 0, failed: [] };
  for (const hook of hooks) {
    const res = await ensureHookIndexed(client, indexInputFor(hook));
    if (!res.ok) {
      out.failed.push(`${hook.id}: ${res.error}`);
      continue;
    }
    if (res.existed) {
      out.existing++;
      log(`hook ${hook.id} already indexed as node #${res.node}`);
    } else {
      out.created++;
      log(`hook ${hook.id} indexed as node #${res.node}`);
    }
  }
  return out;
}

/** The 9.6 wiring: everything the extension calls at SessionStart / after add. */
export async function syncHooksToMemory(
  client: MemClientLike,
  hooks: Hook[],
  log: (line: string) => void = () => {},
): Promise<SyncCounts> {
  try {
    return await indexHooksToMemory(client, hooks, log);
  } catch (err) {
    log(`hooks memory sync failed: ${String(err)}`);
    return { created: 0, existing: 0, failed: [`sync: ${String(err)}`] };
  }
}