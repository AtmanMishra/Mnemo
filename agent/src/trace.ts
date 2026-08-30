/**
 * Area 5: structured logging and traces.
 *
 * One append-only JSONL file per day in ~/.mnemo/logs/<date>.jsonl. Every
 * record is a span: an id, an optional parent, a kind, timings and attributes.
 * Spans nest by parent_id, so a session's tool calls, model round trips and
 * subagent runs reconstruct into one tree (5.4).
 *
 * 5.7 is not an afterthought here: every attribute goes through `redact()` on
 * the way out. This file writes to disk, and the one thing that must never
 * reach disk is a key.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SpanKind = "session" | "llm" | "tool" | "subagent" | "event";

export interface Span {
  /** Unique within a session. */
  id: string;
  /** Enclosing span, or null for a root. */
  parent_id: string | null;
  /** The session this belongs to; the unit `mnemo traces` prints. */
  session: string;
  kind: SpanKind;
  name: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms; absent while the span is still open. */
  end?: number;
  duration_ms?: number;
  ok?: boolean;
  attrs: Record<string, unknown>;
}

export type Level = "debug" | "info" | "warn" | "error" | "off";
const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 99 };

export function levelFromEnv(env: NodeJS.ProcessEnv = process.env): Level {
  const raw = (env.MNEMO_LOG_LEVEL ?? "info").trim().toLowerCase();
  return (raw in LEVEL_ORDER ? raw : "info") as Level;
}

export function enabled(level: Level, min: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[min] && min !== "off";
}

export function logDir(home = os.homedir()): string {
  return path.join(home, ".mnemo", "logs");
}

export function logFile(home = os.homedir(), when = new Date()): string {
  const date = when.toISOString().slice(0, 10);
  return path.join(logDir(home), `${date}.jsonl`);
}

// --- 5.7 redaction ---------------------------------------------------------

/**
 * Attribute names whose value is a secret whatever it looks like.
 * The term has to sit on a word boundary: a bare substring match redacts
 * `tokens_in`, which is a token COUNT and exactly the thing traces exist to
 * show.
 */
const SECRET_KEY =
  /(^|[_\-.])(api[_-]?key|secret|token|password|passwd|authorization|bearer|credential|access[_-]?key)([_\-.]|$)/i;

/** Shapes that are a secret whatever they are called. */
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,          // openai/anthropic style
  /\bghp_[A-Za-z0-9]{20,}/g,           // github
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,   // slack
  /\bAKIA[0-9A-Z]{16}\b/g,             // aws access key id
];

export const REDACTED = "[redacted]";

/** Values pulled from the environment: whatever the user's real keys are. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_KEY.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v as string);
}

export function redactString(value: string, secrets: string[] = envSecrets()): string {
  let out = value;
  for (const s of secrets) {
    if (s && out.includes(s)) out = out.split(s).join(REDACTED);
  }
  for (const rx of SECRET_VALUE) out = out.replace(rx, REDACTED);
  return out;
}

/**
 * Redact one attribute bag. A key whose NAME looks secret is dropped whole;
 * every string is scanned for secret-shaped content and for the user's actual
 * environment values.
 */
export function redact(attrs: Record<string, unknown>, secrets: string[] = envSecrets()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (SECRET_KEY.test(k)) { out[k] = REDACTED; continue; }
    out[k] = redactValue(v, secrets);
  }
  return out;
}

function redactValue(v: unknown, secrets: string[]): unknown {
  if (typeof v === "string") return redactString(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, secrets));
  if (v && typeof v === "object") return redact(v as Record<string, unknown>, secrets);
  return v;
}

// --- writer ----------------------------------------------------------------

export interface TracerOptions {
  home?: string;
  session?: string;
  level?: Level;
  /** Days of logs to keep. 0 disables pruning. */
  retentionDays?: number;
  now?: () => number;
}

let sessionCounter = 0;

export function newSessionId(now = Date.now()): string {
  sessionCounter += 1;
  return `${new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${sessionCounter}`;
}

/** Rotation is by date; this prunes whatever is older than the window (5.7). */
export function pruneOldLogs(home: string, retentionDays: number, now = Date.now()): string[] {
  if (retentionDays <= 0) return [];
  const dir = logDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    if (Date.parse(`${m[1]}T23:59:59Z`) < cutoff) {
      try {
        fs.rmSync(path.join(dir, name));
        removed.push(name);
      } catch { /* a log we cannot delete is not worth failing a session over */ }
    }
  }
  return removed;
}

export class Tracer {
  readonly session: string;
  private readonly home: string;
  private readonly level: Level;
  private readonly now: () => number;
  /** Stack of open span ids, so nesting needs no bookkeeping at call sites. */
  private stack: string[] = [];
  private seq = 0;

  constructor(opts: TracerOptions = {}) {
    this.home = opts.home ?? os.homedir();
    this.level = opts.level ?? levelFromEnv();
    this.now = opts.now ?? Date.now;
    this.session = opts.session ?? newSessionId(this.now());
    if (this.level !== "off") pruneOldLogs(this.home, opts.retentionDays ?? 14, this.now());
  }

  get file(): string {
    return logFile(this.home, new Date(this.now()));
  }

  get currentSpanId(): string | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1]! : null;
  }

  private write(span: Span): void {
    if (this.level === "off") return;
    const file = this.file;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(span) + "\n", { mode: 0o600 });
    } catch { /* tracing must never break the run it is tracing */ }
  }

  /**
   * Open a span. The returned function closes it; everything opened in
   * between nests underneath.
   */
  start(kind: SpanKind, name: string, attrs: Record<string, unknown> = {}, parent?: string | null):
      (result?: { ok?: boolean; attrs?: Record<string, unknown> }) => Span {
    this.seq += 1;
    const id = `${this.session}-${this.seq}`;
    const parent_id = parent !== undefined ? parent : this.currentSpanId;
    const open: Span = {
      id, parent_id, session: this.session, kind, name,
      start: this.now(), attrs: redact(attrs),
    };
    this.stack.push(id);
    return (result = {}) => {
      const end = this.now();
      const span: Span = {
        ...open,
        end,
        duration_ms: end - open.start,
        ok: result.ok ?? true,
        attrs: { ...open.attrs, ...redact(result.attrs ?? {}) },
      };
      // pop this span and anything left open above it
      const at = this.stack.lastIndexOf(id);
      if (at >= 0) this.stack.length = at;
      this.write(span);
      return span;
    };
  }

  /** A point in time rather than an interval. */
  event(name: string, attrs: Record<string, unknown> = {}): Span {
    this.seq += 1;
    const span: Span = {
      id: `${this.session}-${this.seq}`,
      parent_id: this.currentSpanId,
      session: this.session,
      kind: "event",
      name,
      start: this.now(),
      end: this.now(),
      duration_ms: 0,
      ok: true,
      attrs: redact(attrs),
    };
    this.write(span);
    return span;
  }
}

// --- reading (5.5) ---------------------------------------------------------

export function readSpans(home = os.homedir(), date?: string): Span[] {
  const dir = logDir(home);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  if (date) files = files.filter((f) => f.startsWith(date));
  const spans: Span[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        spans.push(JSON.parse(line) as Span);
      } catch { /* a torn last line is not worth discarding the file for */ }
    }
  }
  return spans;
}

export function sessionsOf(spans: Span[]): string[] {
  return [...new Set(spans.map((s) => s.session))].sort();
}

/** Render one session's spans as an indented tree, roots first, in start order. */
export function formatTree(spans: Span[], session?: string): string {
  const rows = spans.filter((s) => !session || s.session === session);
  if (rows.length === 0) return "(no spans)";
  const byParent = new Map<string | null, Span[]>();
  const known = new Set(rows.map((s) => s.id));
  for (const s of rows) {
    // a span whose parent was never written is treated as a root, so nothing
    // is invisible just because a parent span is missing
    const key = s.parent_id && known.has(s.parent_id) ? s.parent_id : null;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(s);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.start - b.start);

  const out: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const s of byParent.get(parent) ?? []) {
      out.push(`${"  ".repeat(depth)}${formatSpan(s)}`);
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return out.join("\n");
}

export function formatSpan(s: Span): string {
  const mark = s.ok === false ? "✖" : "●";
  const dur = s.duration_ms === undefined ? "" : ` ${s.duration_ms}ms`;
  const detail = Object.entries(s.attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${mark} ${s.kind}:${s.name}${dur}${detail ? "  " + detail : ""}`;
}
