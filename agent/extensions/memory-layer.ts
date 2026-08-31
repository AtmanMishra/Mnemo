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
    // A dead child must only fail the requests that were riding on IT. After
    // stop() + a fresh request, the OLD process's exit event arrives while a
    // NEW one is already serving: draining unconditionally resolved that new
    // request with "memsrv exited before responding". That was the ~1-in-8
    // flake in the memory suite.
    proc.once("exit", () => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const [, p] of [...this.pending.entries()]) {
        p.resolve({ ok: false, error: "memsrv exited before responding" });
      }
      this.pending.clear();
    });
    proc.once("error", (err) => {
      if (this.proc !== proc) return;
      this.proc = null;
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
/** One consolidation pass: distil recurring episodes into semantic lessons.
 * Returns the number of lessons standing after the pass. */
export async function runConsolidate(
  client: Pick<MemClient, "request">,
  log: (line: string) => void = console.log,
): Promise<number> {
  const res = await client.request("consolidate");
  if (!res.ok) {
    log(`consolidate failed: ${res.error ?? "unknown error"}`);
    return -1;
  }
  const lessons: Array<{ label: string; occurrences: number; sources: number[] }> =
    res.result?.lessons ?? [];
  for (const l of lessons) {
    log(`${l.label}  x${l.occurrences}  (from ${l.sources.map((s) => `#${s}`).join(" ")})`);
  }
  const applied = Number(res.result?.applied ?? 0);
  log(
    lessons.length === 0
      ? "nothing to consolidate yet (a theme needs at least two episodes)"
      : `${lessons.length} lesson(s), ${applied} op(s) written`,
  );
  return lessons.length;
}

/** One search hit as memsrv returns it. */
export interface Recalled {
  kind: string;
  label: string;
  node: number;
  score: number;
  state: string;
}

/** Prompts too short to carry a topic; searching on them returns noise. */
function worthSearching(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  return words.length >= 3 && prompt.trim().length >= 12;
}

/**
 * Pick which hits are worth spending context on.
 *
 * The score scale depends on the embedding backend (hashing vs OpenRouter), so
 * an absolute floor would be tuned to whichever one happened to be configured.
 * A RELATIVE cut is scale-free: keep what is close to the best hit, drop the
 * long tail. Retrieval is still a guess, which is why the injected block says
 * so rather than presenting hits as established fact.
 */
export function selectRecall(hits: Recalled[], k = 3, relative = 0.6): Recalled[] {
  const scored = hits.filter((h) => Number.isFinite(h.score)).sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  if (best <= 0) return scored.slice(0, k);
  return scored.filter((h) => h.score >= best * relative).slice(0, k);
}

/** Trim one node's state to a line budget so a fat node cannot eat the context. */
export function summariseState(state: string, maxLines = 6, maxChars = 400): string {
  const lines = state.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const kept = lines.slice(0, maxLines).join("\n");
  return kept.length > maxChars ? kept.slice(0, maxChars) + " …" : kept;
}

/**
 * Retrieve memory for this prompt and render it as a system-prompt block.
 *
 * The directive alone asks the model to call memory_search before answering.
 * That costs a whole extra round trip on every turn, and a small model simply
 * ignores it — which is how the agent ends up confidently not knowing
 * something it was told last week. Doing the search here spends one memsrv
 * call (local, no LLM) and puts the answer in front of the model before it
 * thinks, instead of hoping it asks.
 *
 * Returns "" whenever there is nothing worth saying: a short prompt, no hits,
 * or a broken sidecar. Memory must never break the agent loop.
 */
export async function recallFor(
  client: Pick<MemClient, "request">,
  prompt: string,
  k = 3,
): Promise<string> {
  if (!prompt || !worthSearching(prompt)) return "";
  let hits: Recalled[] = [];
  try {
    const res = await client.request("search", { query: prompt, k: Math.max(k * 2, 6) });
    if (!res.ok) return "";
    hits = (res.result?.results ?? []) as Recalled[];
  } catch {
    return ""; // a dead sidecar is a missing convenience, not a failed turn
  }
  const picked = selectRecall(hits, k);
  if (picked.length === 0) return "";
  const body = picked
    .map((h) => `- ${h.label} (${h.kind} #${h.node})\n${summariseState(h.state ?? "")}`)
    .join("\n");
  return [
    "",
    "## Recalled from memory for this message",
    "Retrieved automatically by relevance — these are candidates, not established",
    "fact. Use what fits, ignore what does not, and search for more if you need it.",
    body,
  ].join("\n");
}

export const MEMORY_DIRECTIVE = [
  "",
  "## Persistent memory",
  "You have long-term memory tools: memory_search, memory_write_fact, memory_steer.",
  "- Relevant memory is retrieved for you and appended below when there is any. Call memory_search yourself when that block is missing or does not cover what you need — never claim you lack information without searching first.",
  "- When you learn a durable fact (stack decisions, fixes that worked or failed, credentials locations), store it via memory_write_fact.",
].join("\n");

/** Shared across every registration site so all memory tools hit one episode. */
const sessionState = newLifecycleState();

/** How many NEW episodes a session must add before shutdown consolidates. */
export const CONSOLIDATE_THRESHOLD = 3;

/** Per-process memory lifecycle bookkeeping (episode, dedupe, baseline). */
export interface LifecycleState {
  episodeId: number | null;
  /** Episode count when this process's session started; null = baseline unknown. */
  startEpisodes: number | null;
  /** Per-episode set of already-steered failure signatures (dedupe). */
  steered: Map<number, Set<string>>;
}

export function newLifecycleState(): LifecycleState {
  return { episodeId: null, startEpisodes: null, steered: new Map() };
}

/**
 * One harness bundle as the memory index sees it (name, purpose, tools…).
 * Everything optional except the name: a created bundle always has all of them.
 */
export interface HarnessIndexInput {
  name: string;
  description?: string;
  tools?: string[];
  dir?: string;
  bundleId?: string;
}

/**
 * Index a harness bundle into memory: a Harness kind node in the Procedural
 * area with the manifest carried as facts, so a later procedural search can
 * recall "we built a tool for this" instead of only a disk path.
 *
 * Failures are reported, never thrown — indexing must not break the tool call
 * that created the harness.
 */
export async function indexHarness(
  client: Pick<MemClient, "request">,
  bundle: HarnessIndexInput,
): Promise<{ ok: true; node: number } | { ok: false; error: string }> {
  const facts: Array<[string, string]> = [
    ["description", bundle.description ?? ""],
    ...(bundle.tools ?? []).map((t): [string, string] => ["tool", t]),
  ];
  if (bundle.dir) facts.push(["location", bundle.dir]);
  if (bundle.bundleId) facts.push(["bundle", bundle.bundleId]);
  try {
    const created = await client.request("create_node", {
      kind: "harness",
      area: "procedural",
      label: bundle.name,
    });
    if (!created.ok) return { ok: false, error: created.error ?? "create_node failed" };
    const node = Number(created.result?.node);
    for (const [key, value] of facts) {
      if (!value) continue;
      const f = await client.request("fact", { node, key, value });
      if (!f.ok) return { ok: false, error: `fact ${key}: ${f.error}` };
    }
    return { ok: true, node };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Live TaskEpisode count from the sidecar; null when unreachable. */
export async function countEpisodes(
  client: Pick<MemClient, "request">,
): Promise<number | null> {
  try {
    const res = await client.request("stats");
    if (!res.ok) return null;
    const n = Number(res.result?.episodes);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * One steer per (episode, failure-signature): a rattling tool must paint a
 * pain marker once, not per call — but the same failure in a LATER episode is
 * new evidence and steers again.
 */
export async function autoSteer(
  client: Pick<MemClient, "request">,
  state: LifecycleState,
  kind: "tool" | "turn",
  detail: string,
): Promise<void> {
  if (state.episodeId === null) return;
  const sig = `${kind}:${detail.slice(0, 240)}`;
  const per = state.steered.get(state.episodeId) ?? new Set<string>();
  if (per.has(sig)) return;
  per.add(sig);
  state.steered.set(state.episodeId, per);
  try {
    await client.request("steer", { episode: state.episodeId, failure: detail });
  } catch {
    /* memory must never break the agent loop */
  }
}

/**
 * Shutdown pass: consolidate once the session has added a threshold of new
 * episodes (its own plus any sub-agent sessions sharing the journal). Returns
 * whether a consolidation ran. No baseline -> skip rather than guess.
 */
export async function consolidateIfDue(
  client: Pick<MemClient, "request">,
  state: LifecycleState,
  log: (line: string) => void = console.log,
  threshold: number = CONSOLIDATE_THRESHOLD,
): Promise<boolean> {
  if (state.startEpisodes === null) return false;
  const now = await countEpisodes(client);
  if (now === null) return false;
  const gained = now - state.startEpisodes;
  if (gained < threshold) {
    log(`${gained} new episode(s) this session, below consolidate threshold ${threshold}`);
    return false;
  }
  await runConsolidate(client, log);
  return true;
}


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

export function registerLifecycle(pi: any, client: MemClient = sharedMem, state: LifecycleState = sessionState): void {
  pi.on("session_start", async () => {
    await ensureEpisode(client, state);
    state.startEpisodes = await countEpisodes(client);
  });

  // Appenditive system-prompt chaining: officially recomputed each turn, which
  // is what lets the recalled block be specific to THIS message.
  pi.on("before_agent_start", async (event: any) => ({
    systemPrompt: event.systemPrompt + MEMORY_DIRECTIVE
      + await recallFor(client, String(event.prompt ?? "")),
  }));

  pi.on("tool_execution_end", async (event: any) => {
    try {
      const episode = await ensureEpisode(client, state);
      const detail = `${event.toolName}: ${event.isError ? "error" : "ok"}`;
      await client.request("commit_log", { node: episode, kind: "tool_call", detail });
      if (event.isError) {
        const errText =
          typeof event.result === "string" && event.result.length > 0
            ? `: ${event.result}`
            : "";
        await autoSteer(client, state, "tool", `${event.toolName} failed${errText}`);
      }
    } catch {
      /* memory logging must never break the agent loop */
    }
  });

  // A turn can fail without any tool being in flight (provider error, model
  // timeout). The assistant message records it as stopReason "error" with an
  // errorMessage; steer on exactly that, nothing else.
  pi.on("turn_end", async (event: any) => {
    try {
      const msg = event?.message ?? {};
      if (msg.stopReason !== "error") return;
      await autoSteer(client, state, "turn", msg.errorMessage ?? "turn failed");
    } catch {
      /* ignore */
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      const episode = await ensureEpisode(client, state);
      await client.request("commit_log", { node: episode, kind: "outcome", detail: "session ended" });
    } catch { /* ignore */ }
    try {
      // new episodes this session (own + sub-agents on the same journal) have
      // crossed the threshold: distil them into lessons before we go
      await consolidateIfDue(client, state);
    } catch { /* ignore */ }
    client.stop();
  });

}
