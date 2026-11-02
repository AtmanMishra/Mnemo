/**
 * Ingest other agents' sessions into memory, once each: Claude Code's, Codex's
 * and opencode's.
 *
 * A ledger in the Mnemo home records how many runs of each session have been
 * learned, so running ingest again only learns what is new — a session that
 * grew since is picked up from where it stopped. A session still being
 * written is left alone until it has been quiet for a while, or its last run
 * finished.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryService } from "../service.ts";
import { MemorySession, type MemoryNote, type Reflector, type SkillOffer } from "../session.ts";
import { parseClaudeCode, replay, type ReplaySession } from "./claude-code.ts";
import { parseCodex } from "./codex.ts";
import { opencodeDatabase, opencodeSessions } from "./opencode.ts";

export { parseClaudeCode, replay, type ReplayRun, type ReplaySession, type ReplayTool } from "./claude-code.ts";
export { parseCodex } from "./codex.ts";
export { opencodeDatabase, opencodeSessions, type OpencodeSession } from "./opencode.ts";

export interface IngestOptions {
  memory: MemoryService;
  /** The Mnemo home: where the ledger lives. */
  home: string;
  userSkillsDir: string;
  reflect?: Reflector;
  /** Claude Code's transcripts. Default `~/.claude/projects`. */
  projectsDir?: string;
  /** Only these transcripts (a Stop hook names its own). */
  files?: string[];
  /** Codex's rollouts. Default `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
  codexDir?: string;
  /** opencode's database. Default from `opencodeDatabase()`. */
  opencodeDb?: string;
  /** A session modified within this long is still in use (default 10 minutes). */
  settleMs?: number;
  /** Only sessions whose working directory is inside this one. */
  under?: string;
  /** Skip sessions with fewer tool calls than this in their new runs: small talk teaches nothing. */
  minTools?: number;
  approveSkill?: (offer: SkillOffer) => Promise<boolean>;
  notify?: (sessionId: string, note: MemoryNote) => void;
  /** Called before each session is replayed. */
  progress?: (s: ReplaySession, runs: number) => void;
  now?: number;
}

export interface IngestReport {
  sessions: number;
  runs: number;
  /** Sessions seen with nothing new to learn. */
  unchanged: number;
  /** Sessions skipped because they are still being written. */
  active: number;
}

type Ledger = Record<string, number>;

const ledgerPath = (home: string) => path.join(home, "memory", "ingested.json");

function readLedger(home: string): Ledger {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(home), "utf8")) as Ledger;
  } catch {
    return {};
  }
}

/**
 * Record how many runs of one session are learned. Two ingests (a Stop hook and
 * a manual run) may finish at once: the ledger is re-read under its own lock,
 * only this session's entry changes, and it is replaced whole (tmp + rename) so
 * a reader never sees half a file.
 */
async function recordIngested(home: string, key: string, runs: number): Promise<void> {
  const file = ledgerPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${file}.lock`, { staleMs: 30_000, waitMs: 10_000 });
  try {
    const ledger = readLedger(home);
    ledger[key] = Math.max(ledger[key] ?? 0, runs);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    release?.();
  }
}

/**
 * An exclusive lock file (created with O_EXCL; it holds the owner's pid). A lock
 * older than `staleMs`, or whose owner on this machine is gone, is taken over.
 * Undefined when it is still held after `waitMs`.
 */
export async function acquireLock(file: string, o: { staleMs: number; waitMs?: number }): Promise<(() => void) | undefined> {
  const deadline = Date.now() + (o.waitMs ?? 0);
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, `${process.pid} ${os.hostname()}`);
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (lockIsStale(file, o.staleMs)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function lockIsStale(file: string, staleMs: number): boolean {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > staleMs) return true;
    const [pid, host] = fs.readFileSync(file, "utf8").split(" ");
    if (host !== os.hostname() || !Number(pid)) return false;
    try {
      process.kill(Number(pid), 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false; // gone already, or unreadable: try again
  }
}

/** A session's ingest lock: replaying it with reflection can take minutes. */
const SESSION_LOCK_STALE_MS = 30 * 60_000;

export function claudeCodeSessions(projectsDir = path.join(os.homedir(), ".claude", "projects")): string[] {
  if (!fs.existsSync(projectsDir)) return [];
  return fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      fs
        .readdirSync(path.join(projectsDir, d.name))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(projectsDir, d.name, f)),
    )
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

export function codexSessions(sessionsDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions")): string[] {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir, { recursive: true, encoding: "utf8" })
    .filter((f) => /^rollout-.*\.jsonl$/.test(path.basename(f)))
    .map((f) => path.join(sessionsDir, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

/** A parsed session from one agent, and when it was last written. */
interface Transcript {
  agent: string;
  session: ReplaySession;
  updated: number;
}

function* fromFiles(agent: string, files: string[], parse: (text: string) => ReplaySession | undefined): Generator<Transcript> {
  for (const file of files) {
    const session = parse(fs.readFileSync(file, "utf8"));
    if (session) yield { agent, session, updated: fs.statSync(file).mtimeMs };
  }
}

export function ingestClaudeCode(o: IngestOptions): Promise<IngestReport> {
  return ingest(o, fromFiles("claude-code", o.files ?? claudeCodeSessions(o.projectsDir), parseClaudeCode));
}

export function ingestCodex(o: IngestOptions): Promise<IngestReport> {
  return ingest(o, fromFiles("codex", codexSessions(o.codexDir), parseCodex));
}

function* opencodeTranscripts(file = opencodeDatabase()): Generator<Transcript> {
  for (const { session, updated } of opencodeSessions(file)) yield { agent: "opencode", session, updated };
}

export function ingestOpencode(o: IngestOptions): Promise<IngestReport> {
  return ingest(o, opencodeTranscripts(o.opencodeDb));
}

async function ingest(o: IngestOptions, transcripts: Iterable<Transcript>): Promise<IngestReport> {
  const now = o.now ?? Date.now();
  const settle = o.settleMs ?? 10 * 60_000;
  const report: IngestReport = { sessions: 0, runs: 0, unchanged: 0, active: 0 };
  for (const t of transcripts) {
    const s = t.session;
    if (!s.runs.length) continue;
    if (o.under && !isInside(path.resolve(s.cwd), path.resolve(o.under))) continue;
    const key = `${t.agent}:${s.id}`;
    // One ingest per session at a time: another process (a Stop hook, a manual
    // ingest) replaying the same runs would record every episode twice.
    fs.mkdirSync(path.join(o.home, "memory", "ingest-locks"), { recursive: true, mode: 0o700 });
    const release = await acquireLock(path.join(o.home, "memory", "ingest-locks", `${key.replace(/[^\w.-]/g, "_")}.lock`), { staleMs: SESSION_LOCK_STALE_MS });
    if (!release) {
      report.active++;
      continue;
    }
    try {
      await ingestOne(o, t, key, now, settle, report);
    } finally {
      release();
    }
  }
  return report;
}

/** `child` is `parent` or a folder inside it (`/a/proj` is not inside `/a/pro`). */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function ingestOne(o: IngestOptions, t: Transcript, key: string, now: number, settle: number, report: IngestReport): Promise<void> {
  const s = t.session;
  // Read under the session's lock: what another ingest finished is not learned again.
  const done = readLedger(o.home)[key] ?? 0;
  // The last run may still be going: wait for it to finish or go quiet.
  // settle 0 means do not wait: a file written this very millisecond (or with
  // an mtime a fraction ahead of the clock) is still taken.
  const quiet = settle <= 0 || now - t.updated > settle;
  const complete = quiet || s.runs.at(-1)!.finished ? s.runs.length : s.runs.length - 1;
  const fresh = s.runs.slice(done, complete);
  if (!fresh.length) {
    if (complete < s.runs.length) report.active++;
    else report.unchanged++;
    return;
  }
  if (fresh.reduce((n, r) => n + r.tools.length, 0) >= (o.minTools ?? 1)) {
    o.progress?.(s, fresh.length);
    const session = new MemorySession({
      memory: o.memory,
      cwd: s.cwd,
      userSkillsDir: o.userSkillsDir,
      source: { agent: t.agent, model: s.model },
      reflect: o.reflect,
      approveSkill: o.approveSkill,
      notify: o.notify && ((note) => o.notify!(s.id, note)),
    });
    await replay(session, fresh);
    await session.close();
    report.sessions++;
    report.runs += fresh.length;
  }
  await recordIngested(o.home, key, complete);
}
