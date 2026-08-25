/**
 * Session persistence for sea-agent.
 *
 * JSONL transcript format — one message per line, also the import/export format:
 *   {"role":"user","content":"..."}
 *   {"role":"assistant","content":"..."}
 *
 * saveSession/listSessions/loadSession operate on a session directory
 * (default ~/.sea/sessions). exportSession/importSession are the same
 * read/write primitives against arbitrary paths.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionMessage {
  role: string;
  content: string;
}

export interface SessionSummary {
  name: string;
  file: string;
  mtime: Date;
  messageCount: number;
}

/** Default directory for named sessions. */
export function defaultSessionDir(): string {
  return path.join(os.homedir(), ".sea", "sessions");
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function assertSafeName(name: string): void {
  if (!name || /[\\/]/.test(name) || name.startsWith(".")) {
    throw new Error(`store: invalid session name "${name}"`);
  }
}

function serialize(messages: SessionMessage[]): string {
  return messages.map((m) => JSON.stringify({ role: m.role, content: m.content })).join("\n") + "\n";
}

async function writeTranscript(file: string, messages: SessionMessage[]): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, serialize(messages), "utf8");
}

export async function parseTranscript(file: string): Promise<SessionMessage[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err: any) {
    throw new Error(`store: cannot read ${file}: ${err?.message ?? err}`);
  }
  const messages: SessionMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue; // tolerate blank lines / trailing newline
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // malformed line -> skip gracefully
    }
    if (typeof obj?.role === "string" && typeof obj?.content === "string") {
      messages.push({ role: obj.role, content: obj.content });
    }
  }
  return messages;
}

/** Write `<dir>/<name>.jsonl`; returns the file written. */
export async function saveSession(dir: string, name: string, messages: SessionMessage[]): Promise<string> {
  assertSafeName(name);
  const file = path.join(expandHome(dir), `${name}.jsonl`);
  await writeTranscript(file, messages);
  return file;
}

/** List *.jsonl sessions in dir, newest first. */
export async function listSessions(dir: string): Promise<SessionSummary[]> {
  const root = expandHome(dir);
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return []; // empty/missing dir is not an error
  }
  const out: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = path.join(root, entry);
    try {
      const stat = await fsp.stat(file);
      const messages = await parseTranscript(file);
      out.push({ name: entry.slice(0, -".jsonl".length), file, mtime: stat.mtime, messageCount: messages.length });
    } catch {
      continue; // unreadable file -> skip
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** Load messages from `<dir>/<name>.jsonl`. */
export async function loadSession(dir: string, name: string): Promise<SessionMessage[]> {
  assertSafeName(name);
  return parseTranscript(path.join(expandHome(dir), `${name}.jsonl`));
}

/** Export-format writer to an arbitrary path (same JSONL format). */
export async function exportSession(filePath: string, messages: SessionMessage[]): Promise<string> {
  const file = expandHome(filePath);
  await writeTranscript(file, messages);
  return file;
}

/** Import-format reader from an arbitrary path (same JSONL format). */
export async function importSession(filePath: string): Promise<SessionMessage[]> {
  return parseTranscript(expandHome(filePath));
}
