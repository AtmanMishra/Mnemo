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
 */
import { spawn } from "node:child_process";
import { activeTracing, childTraceEnv as traceEnvFor } from "../../extensions/tracing.ts";
import { SUBAGENT_CHILD_ENV } from "../../extensions/approval-gate.ts";
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
  } = { task: "" },
): Promise<SubagentResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  // default CLI path relative to this module: agent/bin/mnemo.ts
  const cli = process.env.MNEMO_AGENT_BIN ?? process.env.SEA_AGENT_BIN
    ?? path.join(import.meta.dirname ?? ".", "..", "..", "agent", "bin", "mnemo.ts");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, composeChildPrompt(opts.task, opts.context)], {
      // MNEMO_MEMORY_JOURNAL + MNEMO_MEMSRV_BIN propagate EXPLICITLY (P5):
      // the child must share the parent's memory graph and sidecar, even when
      // the parent was configured through the legacy SEA_* names. The trace
      // env makes the child's spans hang off this call's span, so `mnemo
      // traces` shows the whole delegation tree (5.4). MNEMO_SUBAGENT_CHILD
      // marks the process as a delegated child for the approval gate (12.1).
      env: {
        ...process.env,
        ...childMemoryEnv(),
        ...childTraceEnv(),
        [SUBAGENT_CHILD_ENV]: "1",
        ...(opts.env ?? {}),
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
    "The child writes its findings into shared memory automatically.",
  parameters,
  async execute(_id, params: any) {
    try {
      const r = await runSubagent({
        task: params.task,
        context: params.context,
        timeoutMs: params.timeout_ms,
        env: resolveModelEnv(params.model, availableModels()),
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
