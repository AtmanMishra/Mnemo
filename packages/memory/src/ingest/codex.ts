/**
 * Learning from Codex after the fact.
 *
 * Codex keeps each session as a "rollout" of JSON lines in
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (`~/.codex` by
 * default). Every line is `{ timestamp, type, payload }`: `session_meta`
 * names the session and its working directory, `turn_context` the model, and
 * `response_item` carries what the model saw and said — messages, tool calls
 * and their output. `event_msg` lines mark turns finishing or being aborted.
 *
 * A run starts at a user message the person typed. Codex sends its own context
 * (`<environment_context>`, AGENTS.md, skill and hook text) as user messages
 * too: those fragments are left out, and a message with nothing else is not a
 * prompt. Rollouts don't record whether a tool call succeeded; a command that
 * exited non-zero says so in its output, and that is what counts as a failure.
 * Sub-agent threads have their own rollouts and are skipped.
 */
import type { ReplayRun, ReplaySession, ReplayTool } from "./claude-code.ts";

type Item = { type?: string; text?: string };
type Payload = {
  type?: string;
  id?: string;
  cwd?: string;
  model?: string;
  source?: unknown;
  parent_thread_id?: string;
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: string;
  input?: string;
  call_id?: string;
  action?: { command?: unknown };
  output?: unknown;
  error?: unknown;
};
type Line = { type?: string; payload?: Payload };

/** Fragments Codex injects as user text: tagged blocks and the AGENTS.md preamble. */
function injected(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<") || t.startsWith("# AGENTS.md instructions");
}

function texts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  return Array.isArray(content) ? (content as Item[]).filter((c) => typeof c.text === "string").map((c) => c.text!) : [];
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return texts(output).join("\n");
  if (output && typeof output === "object" && "content" in output) return outputText((output as { content: unknown }).content);
  return "";
}

/** The exit code a shell tool reported, if it reported one. */
function exitCode(output: string): number | undefined {
  const head = output.split("\nOutput:")[0]!;
  const m = /^(?:Exit code: |Process exited with code )(-?\d+)$/m.exec(head);
  if (m) return Number(m[1]);
  // Older rollouts: the shell tool answered `{"output": …, "metadata": {"exit_code": n}}`.
  if (output.startsWith("{")) {
    try {
      const code = (JSON.parse(output) as { metadata?: { exit_code?: unknown } }).metadata?.exit_code;
      return typeof code === "number" ? code : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function args(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { input: v };
  } catch {
    return { input: raw };
  }
}

export function parseCodex(jsonl: string): ReplaySession | undefined {
  const lines: Line[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as Line);
    } catch {
      /* a torn last line while the session is still being written */
    }
  }
  const meta = lines.find((l) => l.type === "session_meta")?.payload;
  if (!meta?.id || !meta.cwd) return undefined;
  if (meta.parent_thread_id || (meta.source && typeof meta.source === "object" && "subagent" in meta.source)) return undefined;
  const runs: ReplayRun[] = [];
  const pending = new Map<string, ReplayTool>();
  const models = new Map<string, number>();
  let run: ReplayRun | undefined;
  for (const { type, payload: p } of lines) {
    if (!p) continue;
    if (type === "turn_context" && p.model) models.set(p.model, (models.get(p.model) ?? 0) + 1);
    if (type === "event_msg" && run) {
      if (p.type === "task_complete" || p.type === "turn_complete") run.finished = !p.error;
      if (p.type === "turn_aborted") run.finished = false;
    }
    if (type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      const prompt = texts(p.content)
        .filter((t) => !injected(t))
        .join("\n")
        .trim();
      if (!prompt) continue;
      run = { prompt, messages: [{ role: "user", content: prompt }], tools: [], finished: false };
      runs.push(run);
      continue;
    }
    if (!run) continue;
    if (p.type === "message" && p.role === "assistant") {
      const text = texts(p.content).join("\n");
      if (text.trim()) run.messages.push({ role: "assistant", content: text });
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const input = p.type === "function_call" ? args(p.arguments) : p.type === "custom_tool_call" ? { input: p.input ?? "" } : { command: p.action?.command };
      const tool: ReplayTool = { name: p.name ?? (p.type === "local_shell_call" ? "shell" : "tool"), input, ok: true };
      if (p.call_id) pending.set(p.call_id, tool);
      run.tools.push(tool);
    } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && p.call_id) {
      const tool = pending.get(p.call_id);
      pending.delete(p.call_id);
      const out = outputText(p.output);
      const code = exitCode(out);
      if (tool && code !== undefined && code !== 0) {
        tool.ok = false;
        tool.error = (out.split("\nOutput:\n")[1] ?? out).slice(0, 400);
      }
    }
  }
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { id: meta.id, cwd: meta.cwd, model, runs };
}
