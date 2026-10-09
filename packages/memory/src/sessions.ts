/**
 * Search over what was actually said and run in past sessions.
 *
 * Memory keeps what was *learned* — facts, fixes, session records. This
 * keeps the record itself: every message and command of every session, from
 * Mnemo's own (pi's session files) and from other agents' (Claude Code's), in
 * one SQLite FTS5 index (BM25 ranking), so "how did we fix the login bug last
 * month?" finds the exchange, not a summary of it. Searches stay within one
 * project unless asked otherwise.
 *
 * The index refreshes itself before each search: a file that changed since
 * it was indexed is read again, a file that is gone is dropped. Everything is
 * redacted on the way in.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { redact } from "./redact.ts";
import { parseClaudeCode } from "./ingest/claude-code.ts";

export interface SessionSource {
  /** "mnemo" for pi session files, "claude-code" for Claude Code's. */
  agent: "mnemo" | "claude-code";
  /** A directory searched recursively for *.jsonl. */
  dir: string;
}

export interface SessionHit {
  agent: string;
  session: string;
  cwd: string;
  role: string;
  /** Position of the message in its session. */
  seq: number;
  text: string;
  /** The matching message with neighbouring text around the match. */
  snippet: string;
}

interface Row {
  role: string;
  seq: number;
  text: string;
}

type Block = { type?: string; text?: string; name?: string; arguments?: unknown; input?: unknown };

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => {
      if (b.type === "text") return b.text ?? "";
      if (b.type === "toolCall" || b.type === "tool_use") {
        const args = (b.arguments ?? b.input ?? {}) as Record<string, unknown>;
        const subject = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query;
        return subject ? `$ ${b.name}: ${String(subject)}` : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** A pi session file: a header line, then entries; messages are what is searched. */
function parsePi(jsonl: string): { id: string; cwd: string; rows: Row[] } | undefined {
  let id = "";
  let cwd = "";
  const rows: Row[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; id?: string; cwd?: string; message?: { role?: string; content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session") {
      id = e.id ?? "";
      cwd = e.cwd ?? "";
    } else if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")) {
      const text = blockText(e.message.content).trim();
      if (text) rows.push({ role: e.message.role, seq: rows.length, text });
    }
  }
  return id ? { id, cwd, rows } : undefined;
}

function parseClaude(jsonl: string): { id: string; cwd: string; rows: Row[] } | undefined {
  const s = parseClaudeCode(jsonl);
  if (!s) return undefined;
  const rows: Row[] = [];
  for (const run of s.runs) {
    for (const m of run.messages) rows.push({ role: m.role, seq: rows.length, text: m.content });
    const commands = run.tools.map((t) => {
      const subject = t.input.command ?? t.input.file_path ?? t.input.pattern;
      return subject ? `$ ${t.name}: ${String(subject)}${t.ok ? "" : `  ✗ ${t.error?.split("\n")[0] ?? ""}`}` : "";
    });
    const joined = commands.filter(Boolean).join("\n");
    if (joined) rows.push({ role: "tools", seq: rows.length, text: joined });
  }
  return { id: s.id, cwd: s.cwd, rows };
}

function jsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** FTS5 query from plain words: each word a quoted term, any of them may match (BM25 ranks). */
function ftsQuery(q: string): string | undefined {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  return words.length ? [...new Set(words)].map((w) => `"${w}"`).join(" OR ") : undefined;
}

export class SessionIndex {
  private readonly db: Database;

  constructor(
    file: string,
    private readonly sources: SessionSource[],
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // a platform without modes keeps its own access rules
    }
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER, agent TEXT, session TEXT, cwd TEXT)");
    this.db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(text, role UNINDEXED, seq UNINDEXED, path UNINDEXED, tokenize = 'porter unicode61')",
    );
  }

  /** Bring the index up to date with the files on disk. Returns how many files were (re)read. */
  refresh(): number {
    const known = new Map(
      (this.db.query("SELECT path, mtime, size FROM files").all() as { path: string; mtime: number; size: number }[]).map((r) => [r.path, r]),
    );
    const seen = new Set<string>();
    let read = 0;
    const insert = this.db.prepare("INSERT INTO messages (text, role, seq, path) VALUES (?, ?, ?, ?)");
    for (const src of this.sources)
      for (const file of jsonlFiles(src.dir)) {
        seen.add(file);
        const st = fs.statSync(file);
        const k = known.get(file);
        if (k && k.mtime === st.mtimeMs && k.size === st.size) continue;
        const parsed = (src.agent === "mnemo" ? parsePi : parseClaude)(fs.readFileSync(file, "utf8"));
        this.db.transaction(() => {
          this.db.run("DELETE FROM messages WHERE path = ?", [file]);
          this.db.run("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?, ?)", [file, st.mtimeMs, st.size, src.agent, parsed?.id ?? "", parsed?.cwd ?? ""]);
          for (const r of parsed?.rows ?? []) insert.run(redact(r.text.slice(0, 20_000)), r.role, r.seq, file);
        })();
        read++;
      }
    for (const file of known.keys())
      if (!seen.has(file)) {
        this.db.run("DELETE FROM messages WHERE path = ?", [file]);
        this.db.run("DELETE FROM files WHERE path = ?", [file]);
      }
    return read;
  }

  /** The best-matching messages, optionally only from sessions run inside `under`. */
  search(query: string, o: { k?: number; under?: string; refresh?: boolean } = {}): SessionHit[] {
    if (o.refresh !== false) this.refresh();
    const q = ftsQuery(query);
    if (!q) return [];
    const under = o.under ? path.resolve(o.under) : undefined;
    const rows = this.db
      .query(
        `SELECT m.text, m.role, m.seq, f.agent, f.session, f.cwd, snippet(messages, 0, '«', '»', ' … ', 24) AS snip
         FROM messages m JOIN files f ON f.path = m.path
         WHERE messages MATCH ? ${under ? "AND (f.cwd = ? OR f.cwd LIKE ?)" : ""}
         ORDER BY bm25(messages) LIMIT ?`,
      )
      .all(...([q, ...(under ? [under, `${under}${path.sep}%`] : []), o.k ?? 8] as [string, ...(string | number)[]])) as {
      text: string;
      role: string;
      seq: number;
      agent: string;
      session: string;
      cwd: string;
      snip: string;
    }[];
    return rows.map((r) => ({ agent: r.agent, session: r.session, cwd: r.cwd, role: r.role, seq: Number(r.seq), text: r.text, snippet: r.snip }));
  }

  close(): void {
    this.db.close();
  }
}

/** Hits as a model reads them: where each came from, and the passage. */
export function describeSessionHits(hits: SessionHit[]): string {
  if (!hits.length) return "No past session matches.";
  return hits.map((h) => `- [${h.agent} session ${h.session.slice(0, 8)}, ${h.role} #${h.seq}] ${h.snippet.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
}
