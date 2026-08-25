/**
 * spawn_subagent: hierarchical sub-agent spawning with parent-selected context.
 *
 * The child is a full sea-agent process (same tools, same shared memory journal),
 * started one-shot with a prompt composed of the parent's TASK + CONTEXT BRIEF.
 * The brief is what the parent CHOOSES to pass -- children never inherit the
 * parent transcript. Children write their own findings into the shared memory
 * layer, so siblings and future sessions benefit (the graph is the bus).
 *
 * Overridable for tests: SEA_AGENT_BIN points at any command that prints the
 * child's final answer to stdout.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { Type } from "typebox";
import { textResult, type SeaTool } from "./types.ts";

const parameters = Type.Object({
  task: Type.String({ description: "Self-contained task for the sub-agent." }),
  context: Type.Optional(Type.String({
    description: "Context brief: ONLY what this sub-agent needs (facts, file paths, constraints). Do not paste the whole history.",
  })),
  label: Type.Optional(Type.String({ description: "Short label for logging." })),
  timeout_ms: Type.Optional(Type.Number({ description: "Default 300000.", minimum: 1000 })),
});

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
  opts: { task: string; context?: string; timeoutMs?: number; signal?: AbortSignal } = { task: "" },
): Promise<SubagentResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  // default CLI path relative to this module: agent/bin/sea.ts
  const cli = process.env.SEA_AGENT_BIN
    ?? path.join(import.meta.dirname ?? ".", "..", "..", "agent", "bin", "sea.ts");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, composeChildPrompt(opts.task, opts.context)], {
      env: { ...process.env }, // SEA_MEMORY_JOURNAL inherits -> SHARED memory graph
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

export const subagentSpawnTool: SeaTool = {
  name: "spawn_subagent",
  label: "Spawn sub-agent",
  description:
    "Spawn a hierarchical sub-agent (full sea-agent with all tools + shared memory) to complete one self-contained task. " +
    "Pass ONLY the relevant context in 'context' -- the child does not see this conversation. " +
    "The child writes its findings into shared memory automatically.",
  parameters,
  async execute(_id, params: any) {
    try {
      const r = await runSubagent({
        task: params.task,
        context: params.context,
        timeoutMs: params.timeout_ms,
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
