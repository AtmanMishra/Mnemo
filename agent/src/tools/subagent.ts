/**
 * spawn_subagent: hierarchical sub-agent spawning with parent-selected context.
 *
 * The child is a full mnemo process (same tools, same shared memory journal),
 * started one-shot with a prompt composed of the parent's TASK + CONTEXT BRIEF.
 * The brief is what the parent CHOOSES to pass -- children never inherit the
 * parent transcript. Children write their own findings into the shared memory
 * layer, so siblings and future sessions benefit (the graph is the bus).
 *
 * Overridable for tests: MNEMO_AGENT_BIN points at any command that prints the
 * child's final answer to stdout.
 *
 * The child is spawned with MNEMO_SUBAGENT_CHILD=1 so the approval gate can
 * tell a delegated child (no TTY, no operator) from an automated parent run:
 * in a child, an "ask" on a mutating tool fails CLOSED (audit b6afa93e).
 *
 * 6(b): each child is also stamped with MNEMO_SUBAGENT_DEPTH (its depth in the
 * delegation tree), and spawn_subagent refuses once this process has reached
 * MNEMO_SUBAGENT_MAX_DEPTH (default 3). See the budget block below.
 */
import { spawn } from "node:child_process";
import { activeTracing, childTraceEnv as traceEnvFor } from "../../extensions/tracing.ts";
import { SUBAGENT_CHILD_ENV } from "../../extensions/approval-gate.ts";
import { childShellEnv, sessionEnvFromContext, type PiSessionEnv } from "../childenv.ts";
import * as path from "node:path";
import { Type } from "typebox";
import { textResult, type SeaTool } from "./types.ts";
import { loadAuth } from "../auth/store.ts";

const parameters = Type.Object({
  task: Type.String({ description: "Self-contained task for the sub-agent." }),
  context: Type.Optional(Type.String({
    description: "Context brief: ONLY what this sub-agent needs (facts, file paths, constraints). Do not paste the whole history.",
  })),
  label: Type.Optional(Type.String({ description: "Short label for logging." })),
  timeout_ms: Type.Optional(Type.Number({ description: "Default 300000.", minimum: 1000 })),
  model: Type.Optional(Type.String({
    description:
      "Run this sub-agent on a different model, e.g. 'claude-opus-5' or 'anthropic/claude-opus-5'. " +
      "Must belong to a logged-in provider. Omit to inherit the parent's model.",
  })),
});

// --- 6(b): cap how deep sub-agents may nest ---------------------------------
//
// Delegation was an unbounded resource path: every child is a full agent that
// can itself call spawn_subagent, so one prompt could fork a tree of agents,
// each with its own model spend and memory client, with nothing to stop it
// (research/agentic-capability-review.md, C4/"issue #6").
//
// The budget rides in the ENVIRONMENT, not in memory, because a child is a
// fresh `mnemo.ts` process that shares nothing with its parent but the env it
// was handed: the parent is the only side that knows whether this process is a
// child, so it brands its own child with MNEMO_SUBAGENT_DEPTH = its depth + 1
// (see runSubagent). Depth 0 is the agent the user started.
//
// Default 3, because "one agent per subsystem, each asking for its own
// helpers" is three levels deep (root → child → grandchild → great-grandchild)
// and four agents deep is already more than a person can follow; the point is
// that it is a number, not infinity. MNEMO_SUBAGENT_MAX_DEPTH moves it and is
// inherited by children, so it only has to be set once, on the top-level
// process; 0 forbids delegation entirely, and a bad value (garbage, negative)
// falls back to the default rather than to "unlimited".

/** How deep THIS process is: set by the parent on the child it spawns. */
export const SUBAGENT_DEPTH_ENV = "MNEMO_SUBAGENT_DEPTH";

/** The user's knob for the cap. Inherited by children, so set it once. */
export const SUBAGENT_MAX_DEPTH_ENV = "MNEMO_SUBAGENT_MAX_DEPTH";

/** Default delegation depth budget: the root plus three levels of children. */
export const DEFAULT_SUBAGENT_MAX_DEPTH = 3;

/** Env value -> a non-negative whole number, or undefined when absent/unusable. */
function depthFromEnv(raw: string | undefined): number | undefined {
  const text = raw?.trim() ?? "";
  if (!text) return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** This process's delegation depth: 0 for the agent the user started. */
export function subagentDepth(env: NodeJS.ProcessEnv = process.env): number {
  return depthFromEnv(env[SUBAGENT_DEPTH_ENV]) ?? 0;
}

/** The effective cap. Unset or unusable means the documented default. */
export function subagentMaxDepth(env: NodeJS.ProcessEnv = process.env): number {
  return depthFromEnv(env[SUBAGENT_MAX_DEPTH_ENV]) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

/**
 * Why this process may not spawn a sub-agent, or null when it may. Pure, so the
 * wording — which names the limit and how to raise it — is pinned by tests.
 * Deciding on `depth < max` means the cap counts LEVELS of delegation: with
 * max=1 the root may spawn a child, and that child may not spawn anything.
 */
export function subagentDepthRefusal(depth: number, max: number): string | null {
  if (depth < max) return null;
  return (
    `spawn_subagent refused: sub-agent depth limit reached — this agent is at depth ${depth} ` +
    `(${SUBAGENT_DEPTH_ENV}=${depth}) of a maximum ${max}. Do this task here instead of delegating it. ` +
    `To allow deeper nesting, set ${SUBAGENT_MAX_DEPTH_ENV}=${max + 1} (or higher) in the environment ` +
    `of the top-level mnemo process and restart it.`
  );
}

/** Every model a logged-in provider offers, as "provider/model". */
export function availableModels(home?: string): Array<{ provider: string; model: string }> {
  const auth = home === undefined ? loadAuth() : loadAuth(home);
  return Object.entries(auth.providers ?? {})
    .filter(([, a]) => (a?.key ?? "").length >= 8 && a?.defaultModel)
    .map(([provider, a]) => ({ provider, model: a!.defaultModel! }));
}

/**
 * 8.7: resolve a requested model to the env a child process needs.
 * Omitted means "inherit the parent's", which is the common case and must
 * stay free. A model the user is not logged in to is refused with the list,
 * because silently falling back to the parent's model would look like it
 * worked.
 */
export function resolveModelEnv(
  requested: string | undefined,
  models: Array<{ provider: string; model: string }>,
): Record<string, string> {
  if (!requested || !requested.trim()) return {};
  const want = requested.trim();
  const [maybeProvider, maybeModel] = want.includes("/") ? want.split("/", 2) : [undefined, want];
  const hit = models.find((m) =>
    m.model === maybeModel && (maybeProvider === undefined || m.provider === maybeProvider));
  if (!hit) {
    const list = models.map((m) => `${m.provider}/${m.model}`).join(", ") || "(none logged in)";
    throw new Error(
      `spawn_subagent: "${want}" is not a model of a logged-in provider. Available: ${list}`,
    );
  }
  return { MNEMO_PROVIDER: hit.provider, MNEMO_MODEL: hit.model };
}

export interface SubagentResult {
  answer: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export function composeChildPrompt(task: string, context?: string): string {
  const lines = [
    "You are a sub-agent spawned by a parent agent to complete ONE task.",
    `TASK: ${task}`,
  ];
  if (context && context.trim()) {
    lines.push(`CONTEXT FROM PARENT (trusted, use it; do not re-research): ${context}`);
  }
  lines.push(
    "Use your memory tools to store anything you learn or decide (memory_write_fact),",
    "and search memory before claiming you do not know something.",
    "End with a concise final answer line starting with 'ANSWER:'.",
  );
  return lines.join("\n");
}

export function runSubagent(
  opts: {
    task: string; context?: string; timeoutMs?: number; signal?: AbortSignal;
    /** Extra env for the child, e.g. a different model (8.7). */
    env?: Record<string, string>;
    /** Live session facts to publish to the child (D6); see childShellEnv. */
    session?: PiSessionEnv;
  } = { task: "" },
): Promise<SubagentResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  // default CLI path relative to this module: agent/bin/mnemo.ts
  const cli = process.env.MNEMO_AGENT_BIN ?? process.env.SEA_AGENT_BIN
    ?? path.join(import.meta.dirname ?? ".", "..", "..", "agent", "bin", "mnemo.ts");
  // 6(b): the child is one level deeper than this process. Counted here, from
  // the env the parent handed US, so the chain cannot be reset by a child
  // that simply forgets to pass it on.
  const childDepth = subagentDepth() + 1;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, composeChildPrompt(opts.task, opts.context)], {
      // MNEMO_MEMORY_JOURNAL + MNEMO_MEMSRV_BIN propagate EXPLICITLY (P5):
      // the child must share the parent's memory graph and sidecar, even when
      // the parent was configured through the legacy SEA_* names. The trace
      // env makes the child's spans hang off this call's span, so `mnemo
      // traces` shows the whole delegation tree (5.4). MNEMO_SUBAGENT_CHILD
      // marks the process as a delegated child for the approval gate (12.1).
      // 12.7: the env is scrubbed of credentials — the child re-authenticates
      // from ~/.mnemo/auth.json, so a delegated model never sees the key.
      // D6: it also carries the PI_* session values (the child strips them
      // again before handing anything to its own shells, and publishes its
      // own session there).
      env: {
        ...childShellEnv(opts.session),
        ...childMemoryEnv(),
        ...childTraceEnv(),
        [SUBAGENT_CHILD_ENV]: "1",
        ...(opts.env ?? {}),
        // 6(b): the depth budget is OURS to set, last so a caller-supplied env
        // cannot make a child look shallower than it is.
        [SUBAGENT_DEPTH_ENV]: String(childDepth),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (r: SubagentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(e); }
    });
    child.on("exit", (code) => {
      if (opts.signal?.aborted) child.kill("SIGKILL");
      finish({
        answer: stdout.trim(),
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
      });
      void stderr;
    });
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    }
  });
}

/** Extract the ANSWER: line if the child followed instructions; else full text. */
export function extractAnswer(stdout: string): string {
  const lines = stdout.split("\n").filter((l) => l.startsWith("ANSWER:"));
  if (lines.length > 0) return lines[lines.length - 1]!.slice("ANSWER:".length).trim();
  return stdout.trim();
}

/**
 * The memory env a child MUST inherit to share the parent's graph.
 *
 * Explicit rather than implicit: canonicalises the MODERN variable names even
 * when the parent was configured through the legacy SEA_* aliases, so the
 * child's MemClient resolves the SAME journal and sidecar the parent uses —
 * not merely "whatever happened to be in process.env". Empty when the parent
 * runs on defaults (both processes resolve identical defaults from the same
 * repo, so nothing needs carrying).
 */
export function childMemoryEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const journal = process.env.MNEMO_MEMORY_JOURNAL ?? process.env.SEA_MEMORY_JOURNAL;
  if (journal) out.MNEMO_MEMORY_JOURNAL = journal;
  const bin = process.env.MNEMO_MEMSRV_BIN ?? process.env.SEA_MEMSRV_BIN;
  if (bin) out.MNEMO_MEMSRV_BIN = bin;
  return out;
}

/** Trace ids to hand the child, or nothing when tracing is off. */
function childTraceEnv(): Record<string, string> {
  const t = activeTracing();
  return t ? traceEnvFor(t.tracer) : {};
}

export const subagentSpawnTool: SeaTool = {
  name: "spawn_subagent",
  label: "Spawn sub-agent",
  description:
    "Spawn a hierarchical sub-agent (full mnemo agent with all tools + shared memory) to complete one self-contained task. " +
    "Pass ONLY the relevant context in 'context' -- the child does not see this conversation. " +
    "The child writes its findings into shared memory automatically. " +
    "Delegation is depth-limited (MNEMO_SUBAGENT_MAX_DEPTH, default 3): a sub-agent may spawn its own " +
    "children until the budget is spent, and the call is refused past it.",
  parameters,
  async execute(_id, params: any, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: any) {
    // 6(b): refuse past the depth budget with an ordinary tool result -- the
    // model gets a message it can act on, never a crash and never a silenced
    // guard. Checked here (not in runSubagent) because this is the call pi
    // exposes; runSubagent still stamps the child's depth either way.
    const refused = subagentDepthRefusal(subagentDepth(), subagentMaxDepth());
    if (refused) return textResult(refused);
    try {
      const r = await runSubagent({
        task: params.task,
        context: params.context,
        timeoutMs: params.timeout_ms,
        env: resolveModelEnv(params.model, availableModels()),
        // D6: the child inherits this session's PI_* values in its process
        // env; its own shells publish the child's session instead.
        session: sessionEnvFromContext(ctx),
      });
      const answer = r.timedOut
        ? `(sub-agent timed out after ${r.durationMs}ms)`
        : extractAnswer(r.answer);
      return textResult(
        `${answer}\n(sub-agent ${r.timedOut ? "TIMED OUT" : "finished"} in ${(r.durationMs / 1000).toFixed(1)}s, exit=${r.exitCode})`,
      );
    } catch (err: any) {
      return textResult(`sub-agent failed to start: ${err?.message ?? err}`);
    }
  },
};
