/**
 * Learning from opencode after the fact.
 *
 * opencode keeps every session in one SQLite database,
 * `~/.local/share/opencode/opencode.db` (`$XDG_DATA_HOME/opencode`, or
 * `$OPENCODE_DB`). Two layouts exist:
 *
 * - opencode 2 writes `session_v2` and `session_message`: one row per message,
 *   typed `user`, `assistant` (text, reasoning and tool calls with their
 *   state), `idle` (the turn ended, with its outcome), and context it injects
 *   itself (`synthetic`, `system`, `skill`, `compaction`, …).
 * - opencode 1 wrote `session`, `message` and `part`: messages with a role,
 *   and their text and tool parts. opencode 2 copies these into its own tables
 *   on first start, so they are read only when `session_v2` is absent.
 *
 * A run starts at a message the person typed. Sub-agent sessions (those with a
 * parent) are their own sessions and are skipped, as Claude Code's sidechains are.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReplayRun, ReplaySession, ReplayTool } from "./claude-code.ts";

export interface OpencodeSession {
  session: ReplaySession;
  /** When it was last written (ms): a session still in use is left until it goes quiet. */
  updated: number;
}

export function opencodeDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const data = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode");
  const db = env.OPENCODE_DB;
  if (db && db !== ":memory:") return path.isAbsolute(db) ? db : path.join(data, db);
  return path.join(data, "opencode.db");
}

type Tool = { status?: string; input?: Record<string, unknown>; error?: unknown };
type V2Content = { type?: string; text?: string; name?: string; state?: Tool };
type V2Data = { text?: string; content?: V2Content[]; model?: { id?: string }; outcome?: string };
type V1Message = { role?: string; modelID?: string; summary?: boolean; finish?: string; error?: unknown };
type V1Part = { type?: string; text?: string; synthetic?: boolean; ignored?: boolean; tool?: string; state?: Tool };

function json<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function toolOf(name: string, state: Tool | undefined): ReplayTool {
  const tool: ReplayTool = { name, input: state?.input ?? {}, ok: state?.status !== "error" };
  if (!tool.ok) {
    const e = state?.error;
    tool.error = (typeof e === "string" ? e : typeof (e as { message?: unknown })?.message === "string" ? (e as { message: string }).message : "").slice(0, 400);
  }
  return tool;
}

function topModel(models: Map<string, number>): string | undefined {
  return [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function v2Session(db: Database, id: string, cwd: string): ReplaySession {
  const runs: ReplayRun[] = [];
  const models = new Map<string, number>();
  let run: ReplayRun | undefined;
  for (const row of db.query<{ type: string; data: string }, [string]>("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq").iterate(id)) {
    const d = json<V2Data>(row.data);
    if (!d) continue;
    if (row.type === "user") {
      const prompt = (d.text ?? "").trim();
      if (!prompt) continue;
      run = { prompt, messages: [{ role: "user", content: prompt }], tools: [], finished: false };
      runs.push(run);
    } else if (row.type === "assistant" && run) {
      if (d.model?.id) models.set(d.model.id, (models.get(d.model.id) ?? 0) + 1);
      for (const c of d.content ?? []) {
        if (c.type === "text" && c.text?.trim()) run.messages.push({ role: "assistant", content: c.text });
        if (c.type === "tool" && c.name) run.tools.push(toolOf(c.name, c.state));
      }
      run.finished = false;
    } else if (row.type === "idle" && run) {
      run.finished = d.outcome === "succeeded";
    }
  }
  return { id, cwd, model: topModel(models), runs };
}

function v1Session(db: Database, id: string, cwd: string): ReplaySession {
  const parts = new Map<string, V1Part[]>();
  for (const p of db.query<{ message_id: string; data: string }, [string]>("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id").iterate(id)) {
    const part = json<V1Part>(p.data);
    if (part) parts.set(p.message_id, [...(parts.get(p.message_id) ?? []), part]);
  }
  const runs: ReplayRun[] = [];
  const models = new Map<string, number>();
  let run: ReplayRun | undefined;
  for (const row of db.query<{ id: string; data: string }, [string]>("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id").iterate(id)) {
    const m = json<V1Message>(row.data);
    const own = parts.get(row.id) ?? [];
    if (m?.role === "user") {
      const prompt = own
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      if (!prompt) continue;
      run = { prompt, messages: [{ role: "user", content: prompt }], tools: [], finished: false };
      runs.push(run);
    } else if (m?.role === "assistant" && !m.summary && run) {
      if (m.modelID) models.set(m.modelID, (models.get(m.modelID) ?? 0) + 1);
      for (const p of own) {
        if (p.type === "text" && !p.synthetic && p.text?.trim()) run.messages.push({ role: "assistant", content: p.text });
        if (p.type === "tool" && p.tool) run.tools.push(toolOf(p.tool, p.state));
      }
      run.finished = m.finish === "stop" && !m.error;
    }
  }
  return { id, cwd, model: topModel(models), runs };
}

/** Every top-level session in an opencode database, oldest first; none if it is missing or unreadable. */
export function* opencodeSessions(file = opencodeDatabase()): Generator<OpencodeSession> {
  if (!fs.existsSync(file)) return;
  let db: Database;
  try {
    db = new Database(file, { readonly: true });
  } catch {
    return;
  }
  try {
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    const v2 = tables.has("session_v2") && tables.has("session_message");
    if (!v2 && !(tables.has("session") && tables.has("message") && tables.has("part"))) return;
    const [sessions, messages] = v2 ? ["session_v2", "session_message"] : ["session", "message"];
    const rows = db
      .query<{ id: string; directory: string; updated: number }, []>(
        `SELECT s.id, s.directory, max(s.time_updated, coalesce((SELECT max(m.time_updated) FROM ${messages} m WHERE m.session_id = s.id), 0)) AS updated
         FROM ${sessions} s WHERE s.parent_id IS NULL AND s.directory != '' ORDER BY updated`,
      )
      .all();
    for (const r of rows) yield { session: (v2 ? v2Session : v1Session)(db, r.id, r.directory), updated: r.updated };
  } finally {
    db.close();
  }
}
