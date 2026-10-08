/**
 * Ingest other agents' sessions into memory, once each.
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

export { parseClaudeCode, replay, type ReplayRun, type ReplaySession, type ReplayTool } from "./claude-code.ts";

export interface IngestOptions {
  memory: MemoryService;
  /** The Mnemo home: where the ledger lives. */
  home: string;
  userSkillsDir: string;
  reflect?: Reflector;
  /** Default `~/.claude/projects`. */
  projectsDir?: string;
  /** Only these transcripts (a Stop hook names its own). */
  files?: string[];
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

function writeLedger(home: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(ledgerPath(home)), { recursive: true });
  fs.writeFileSync(ledgerPath(home), JSON.stringify(ledger, null, 2));
}

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

export async function ingestClaudeCode(o: IngestOptions): Promise<IngestReport> {
  const now = o.now ?? Date.now();
  const settle = o.settleMs ?? 10 * 60_000;
  const ledger = readLedger(o.home);
  const report: IngestReport = { sessions: 0, runs: 0, unchanged: 0, active: 0 };
  for (const file of o.files ?? claudeCodeSessions(o.projectsDir)) {
    const s = parseClaudeCode(fs.readFileSync(file, "utf8"));
    if (!s || !s.runs.length) continue;
    if (o.under && !path.resolve(s.cwd).startsWith(path.resolve(o.under))) continue;
    const key = `claude-code:${s.id}`;
    const done = ledger[key] ?? 0;
    // The last run may still be going: wait for it to finish or go quiet.
    // settle 0 means do not wait: a file written this very millisecond (or with
    // an mtime a fraction ahead of the clock) is still taken.
    const quiet = settle <= 0 || now - fs.statSync(file).mtimeMs > settle;
    const complete = quiet || s.runs.at(-1)!.finished ? s.runs.length : s.runs.length - 1;
    const fresh = s.runs.slice(done, complete);
    if (!fresh.length) {
      if (complete < s.runs.length) report.active++;
      else report.unchanged++;
      continue;
    }
    if (fresh.reduce((n, r) => n + r.tools.length, 0) >= (o.minTools ?? 1)) {
      o.progress?.(s, fresh.length);
      const session = new MemorySession({
        memory: o.memory,
        cwd: s.cwd,
        userSkillsDir: o.userSkillsDir,
        source: { agent: "claude-code", model: s.model },
        reflect: o.reflect,
        approveSkill: o.approveSkill,
        notify: o.notify && ((note) => o.notify!(s.id, note)),
      });
      await replay(session, fresh);
      await session.close();
      report.sessions++;
      report.runs += fresh.length;
    }
    ledger[key] = complete;
    writeLedger(o.home, ledger);
  }
  return report;
}
