/**
 * Memory-layer extension: persistent semantic memory via the memsrv sidecar.
 *
 * Spawns memory-layer/target/debug/memsrv (line-delimited JSON-RPC over stdio,
 * banner on stderr only) and registers three pi tools:
 *
 *   memory_search      {query, k?}
 *   memory_write_fact  {node?, label?, key, value}
 *   memory_steer       {failure, fix?}
 *
 * Session lifecycle: session start records a TaskEpisode node; every completed
 * tool call appends a commit_log entry; session shutdown logs the outcome and
 * stops the sidecar. Journal path defaults to
 * memory-layer/data/sea-agent-journal.jsonl under the repo root and can be
 * overridden with MNEMO_MEMORY_JOURNAL (legacy SEA_MEMORY_JOURNAL still works).
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_BINARY = path.join(REPO_ROOT, "memory-layer", "target", "debug", "memsrv");
const DEFAULT_JOURNAL = path.join(REPO_ROOT, "memory-layer", "data", "sea-agent-journal.jsonl");

export interface MemResult {
  ok: boolean;
  /** Response payload when ok is true. */
  result?: any;
  /** Error string when ok is false. */
  error?: string;
}

interface Pending {
  resolve: (value: MemResult) => void;
}

/** Client for one long-lived memsrv process. Requests are serialized FIFO. */
export class MemClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private queue: Promise<unknown> = Promise.resolve();
  private stderrTail: string[] = [];
  private readonly binaryPath: string;
  private readonly journalPath: string;

  constructor(opts: { binaryPath?: string; journalPath?: string } = {}) {
    this.binaryPath = opts.binaryPath ?? ((process.env.MNEMO_MEMSRV_BIN ?? process.env.SEA_MEMSRV_BIN) || DEFAULT_BINARY);
    this.journalPath = opts.journalPath ?? ((process.env.MNEMO_MEMORY_JOURNAL ?? process.env.SEA_MEMORY_JOURNAL) || DEFAULT_JOURNAL);
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  get journal(): string {
    return this.journalPath;
  }

  /** Send one request; resolves when memsrv answers this exact id. */
  request(method: string, params: Record<string, unknown> = {}): Promise<MemResult> {
    const task = this.queue.then(async () => {
      this.start();
      return await this.requestImmediate(method, params);
    });
    // One failed request must not poison the chain.
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Fire-and-forget shutdown: ask memsrv to exit, then SIGKILL as backup. */
  stop(): void {
    const old = this.proc;
    this.proc = null;
    this.pending.clear();
    if (!old) return;
    try {
      old.stdin?.write(JSON.stringify({ method: "exit" }) + "\n");
    } catch { /* already gone */ }
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
      throw new Error(
        `memsrv binary not found at ${this.binaryPath}. Build it with:\n` +
          `  cd ${path.join(REPO_ROOT, "memory-layer")} && cargo build --bin memsrv`,
      );
    }
    fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });

    // Strip OPENROUTER_API_KEY so the deterministic hashing embedder is used
    // unless callers explicitly opt in via SEA_MEMORY_REMOTE=1.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (env.SEA_MEMORY_REMOTE !== "1") delete env.OPENROUTER_API_KEY;

    const proc = spawn(this.binaryPath, [this.journalPath], {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.buffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString("utf8"));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    proc.once("exit", () => {
      if (this.proc === proc) this.proc = null;
      for (const [, p] of [...this.pending.entries()]) {
        p.resolve({ ok: false, error: "memsrv exited before responding" });
      }
      this.pending.clear();
    });
    proc.once("error", (err) => {
      if (this.proc === proc) this.proc = null;
      for (const [, p] of [...this.pending.entries()]) p.resolve({ ok: false, error: String(err) });
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
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // banner noise would go to stderr, but be defensive anyway
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(
          msg.ok
            ? { ok: true, result: msg.result }
            : { ok: false, error: typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error) },
        );
      }
    }
  }

  private requestImmediate(method: string, params: Record<string, unknown>): Promise<MemResult> {
    const id = this.nextId++;
    const stdin = this.proc?.stdin ?? null;
    if (!this.proc || !stdin) {
      return Promise.resolve({ ok: false, error: "memsrv is not running" });
    }
    return new Promise<MemResult>((resolve) => {
      this.pending.set(id, { resolve });
      try {
        stdin.write(JSON.stringify({ id, method, params }) + "\n");
      } catch (err) {
        this.pending.delete(id);
        resolve({ ok: false, error: `memsrv stdin write failed: ${String(err)}` });
      }
    });
  }

  lastStderr(): string {
    return this.stderrTail.join("");
  }
}

/** Shared client so all three tools hit the same memory sidecar. */
export const sharedMem = new MemClient();

function fmt(res: MemResult): string {
  if (res.ok) return JSON.stringify(res.result);
  return `error: ${res.error}`;
}

async function ensureEpisode(client: MemClient, state: { episodeId: number | null }): Promise<number> {
  if (state.episodeId !== null) return state.episodeId;
  const res = await client.request("episode", { label: `pi session ${new Date().toISOString()}` });
  if (!res.ok) throw new Error(`memory episode failed: ${res.error}`);
  state.episodeId = Number(res.result.episode);
  return state.episodeId;
}

const searchParams = Type.Object({
  query: Type.String({ description: "Natural-language query against the memory layer." }),
  k: Type.Optional(Type.Number({ description: "Max results. Default 5.", minimum: 1 })),
});

const writeFactParams = Type.Object({
  node: Type.Optional(Type.Number({ description: "Existing node id to attach the fact to." })),
  label: Type.Optional(Type.String({ description: "Label used when creating a fresh node (no node given)." })),
  key: Type.String({ description: "Fact key, e.g. 'status' or 'build_cmd'." }),
  value: Type.String({ description: "Fact value." }),
});

const steerParams = Type.Object({
  failure: Type.String({ description: "What went wrong in the current episode." }),
  fix: Type.Optional(
    Type.Object({
      node: Type.Number({ description: "Node whose fact was wrong." }),
      fact: Type.Number({ description: "Fact id to supersede." }),
      new_key: Type.Optional(Type.String()),
      new_value: Type.Optional(Type.String()),
    }),
  ),
});

/**
 * Persistent-memory directive appended to the system prompt on every turn via
 * the before_agent_start hook (small models need an explicit instruction to
 * consult/store memory proactively; validated by eval/memory-eval.mjs).
 */
export const MEMORY_DIRECTIVE = [
  "",
  "## Persistent memory",
  "You have long-term memory tools: memory_search, memory_write_fact, memory_steer.",
  "- ALWAYS call memory_search BEFORE answering any question about this project, its services, ports, tooling, or past work. Never claim you lack information without searching first.",
  "- When you learn a durable fact (stack decisions, fixes that worked or failed, credentials locations), store it via memory_write_fact.",
].join("\n");

/** Shared across every registration site so all memory tools hit one episode. */
const sessionState = { episodeId: null as number | null };

/** The three memory tools as pi-compatible ToolDefinitions (shared instances). */
export function makeMemoryTools(): any[] {
  const client = sharedMem;
  return [
    {
      name: "memory_search",
      label: "Memory search",
      description: "Semantic search over the persistent memory layer (episodes, facts, outcomes).",
      parameters: searchParams,
      async execute(_id: string, params: any) {
        const res = await client.request("search", { query: params.query, k: params.k ?? 5 });
        return { content: [{ type: "text", text: fmt(res) }], details: res.result ?? { error: res.error } };
      },
    },
    {
      name: "memory_write_fact",
      label: "Memory write fact",
      description:
        "Attach a key/value fact to a memory node. Creates a fresh aspect node (label defaults " +
        "to the key) when no node id is given.",
      parameters: writeFactParams,
      async execute(_id: string, params: any) {
        let nodeId = params.node;
        if (nodeId === undefined) {
          const created = await client.request("create_node", {
            kind: "aspect",
            label: params.label ?? params.key,
          });
          if (!created.ok) throw new Error(`memory_write_fact: ${created.error}`);
          nodeId = Number(created.result.node);
        }
        const res = await client.request("fact", { node: nodeId, key: params.key, value: params.value });
        if (!res.ok) throw new Error(`memory_write_fact: ${res.error}`);
        return {
          content: [{ type: "text", text: `fact ${res.result.fact} written to node ${nodeId}` }],
          details: { node: nodeId, fact: res.result.fact },
        };
      },
    },
    {
      name: "memory_steer",
      label: "Memory steer",
      description:
        "Record a failure in the current episode and let the memory layer blame/supersede the " +
        "context that caused it.",
      parameters: steerParams,
      async execute(_id: string, params: any) {
        const episode = await ensureEpisode(client, sessionState);
        const body: Record<string, unknown> = { episode, failure: params.failure };
        if (params.fix) {
          body.fix = {
            node: params.fix.node,
            fact: params.fix.fact,
            new_key: params.fix.new_key,
            new_value: params.fix.new_value,
          };
        }
        const res = await client.request("steer", body);
        return { content: [{ type: "text", text: fmt(res) }], details: res.result ?? { error: res.error } };
      },
    },
  ];
}

/** Registers ONLY the lifecycle hooks + directive (tools come from elsewhere). */
export function memoryLayerHooks(pi: any): void {
  registerLifecycle(pi);
}

/**
 * Registers the memory tools plus lifecycle logging onto a pi extension API.
 * Standalone entry point: sea-tools-inline already provides the tools when
 * both extensions run together (pi rejects duplicate tool names).
 */
export default function memoryLayerExtension(pi: any): void {
  for (const tool of makeMemoryTools()) pi.registerTool(tool);
  registerLifecycle(pi);
}

function registerLifecycle(pi: any): void {
  const client = sharedMem;

  pi.on("session_start", async () => {
    await ensureEpisode(client, sessionState);
  });

  // Appenditive system-prompt chaining: officially recomputed each turn.
  pi.on("before_agent_start", async (event: any) => ({
    systemPrompt: event.systemPrompt + MEMORY_DIRECTIVE,
  }));

  pi.on("tool_execution_end", async (event: any) => {
    try {
      const episode = await ensureEpisode(client, sessionState);
      const detail = `${event.toolName}: ${event.isError ? "error" : "ok"}`;
      await client.request("commit_log", { node: episode, kind: "tool_call", detail });
    } catch {
      /* memory logging must never break the agent loop */
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      const episode = await ensureEpisode(client, sessionState);
      await client.request("commit_log", { node: episode, kind: "outcome", detail: "session ended" });
    } catch { /* ignore */ }
    client.stop();
  });

}
