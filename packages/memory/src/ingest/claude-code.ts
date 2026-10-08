/**
 * Learning from Claude Code after the fact.
 *
 * Claude Code keeps every session as JSON lines in
 * `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`: the person's prompts,
 * the model's text and tool calls, and each tool's result. That is enough to
 * replay a session through a `MemorySession` — the same loop Mnemo runs live —
 * so a session worked by a frontier model teaches the memory a cheaper model
 * will use. No hook or integration is needed; the files are already there.
 *
 * A *run* is one human prompt and everything up to the next one. Turns the
 * harness injects (task notifications, hook feedback, slash-command output,
 * compaction summaries) are context, not prompts. Sub-agent rows
 * (`isSidechain`) belong to their own files and are skipped here.
 */
import type { MemorySession } from "../session.ts";

export interface ReplayTool {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface ReplayRun {
  prompt: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /** Tool calls in order, with their outcome. */
  tools: ReplayTool[];
  /** The assistant said it was done (not interrupted, not cut off). */
  finished: boolean;
}

export interface ReplaySession {
  id: string;
  cwd: string;
  /** The model most of the session's answers came from. */
  model?: string;
  runs: ReplayRun[];
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Row = {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  cwd?: string;
  sessionId?: string;
  message?: { role?: string; model?: string; content?: unknown; stop_reason?: string | null };
};

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function plain(content: unknown): string {
  return blocks(content)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/** A prompt a person typed — not a tool result, nor anything the harness injected. */
function humanPrompt(row: Row): string | undefined {
  if (row.type !== "user" || row.isSidechain || row.isMeta || row.isCompactSummary) return undefined;
  const content = row.message?.content;
  if (blocks(content).some((b) => b.type === "tool_result")) return undefined;
  const text = plain(content).trim();
  if (!text) return undefined;
  if (row.origin?.kind) return row.origin.kind === "human" ? text : undefined;
  // Older transcripts have no origin: injected turns are tagged or bracketed.
  return /^\s*[<[]/.test(text) ? undefined : text;
}

export function parseClaudeCode(jsonl: string): ReplaySession | undefined {
  const rows: Row[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      /* a torn last line while the session is still being written */
    }
  }
  const first = rows.find((r) => r.sessionId && r.cwd);
  if (!first) return undefined;
  const runs: ReplayRun[] = [];
  const pending = new Map<string, ReplayTool>();
  const models = new Map<string, number>();
  let run: ReplayRun | undefined;
  for (const row of rows) {
    if (row.isSidechain) continue;
    const prompt = humanPrompt(row);
    if (prompt !== undefined) {
      run = { prompt, messages: [{ role: "user", content: prompt }], tools: [], finished: false };
      runs.push(run);
      continue;
    }
    if (!run) continue;
    const m = row.message;
    if (row.type === "assistant" && m) {
      if (m.model && !m.model.startsWith("<")) models.set(m.model, (models.get(m.model) ?? 0) + 1);
      for (const b of blocks(m.content)) {
        if (b.type === "text" && b.text?.trim()) run.messages.push({ role: "assistant", content: b.text });
        if (b.type === "tool_use" && b.id && b.name) {
          const tool: ReplayTool = { name: b.name, input: (b.input ?? {}) as Record<string, unknown>, ok: true };
          pending.set(b.id, tool);
          run.tools.push(tool);
        }
      }
      run.finished = m.stop_reason === "end_turn";
    } else if (row.type === "user" && m) {
      for (const b of blocks(m.content)) {
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        const tool = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        if (tool && b.is_error) {
          tool.ok = false;
          tool.error = (typeof b.content === "string" ? b.content : plain(b.content)).slice(0, 400);
        }
      }
    }
  }
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { id: first.sessionId!, cwd: first.cwd!, model, runs };
}

/**
 * Replay runs through a session: each one begins, its tool calls are
 * observed in order, its words are credited, and it ends (which reflects).
 * Unfinished runs are replayed too — a failure the person interrupted is
 * still a failure worth knowing about.
 */
export async function replay(session: MemorySession, runs: readonly ReplayRun[]): Promise<void> {
  for (const run of runs) {
    await session.begin(run.prompt);
    for (const t of run.tools) {
      session.toolStart(t.name, t.input);
      await session.toolEnd(t.name, t.input, t.ok, t.error);
    }
    for (const m of run.messages) if (m.role === "assistant") session.text(m.content);
    await session.end({ messages: run.messages });
  }
}
