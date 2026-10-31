/**
 * The files a session leaves beside its transcript, as plain local files any tool can read:
 *
 *   <session>.jsonl              pi's transcript (pi writes it)
 *   <session>/sub/<…>.jsonl      each sub-agent's transcript, any depth (pi writes them)
 *   <session>.state.json         what the session is doing: its agents, their models,
 *                                limits, spend and answers, ended ones included
 *
 * The state file is written by its own process only, whole, by rename, so a reader never
 * sees half of one. Everything in it already went through the roster's `clean` (redacted).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { NodeStatus, RosterNode } from "./roster.ts";

const stem = (sessionFile: string) => sessionFile.replace(/\.jsonl$/, "");

/** Where the sub-agents of the session in `sessionFile` keep their transcripts. */
export const subDirOf = (sessionFile: string): string => path.join(stem(sessionFile), "sub");

export const stateFileOf = (sessionFile: string): string => `${stem(sessionFile)}.state.json`;

/** One agent as the state file keeps it. */
export type StateNode = Pick<
  RosterNode,
  "id" | "kind" | "parent" | "label" | "task" | "depth" | "access" | "status" | "model" | "thinking" | "caps" | "turns" | "spent" | "startedAt" | "endedAt" | "answer" | "transcript" | "pending"
>;

export interface SessionState {
  version: 1;
  /** pi's session id and transcript. */
  session: string;
  transcript: string;
  pid: number;
  cwd: string;
  updatedAt: number;
  mode: string;
  /** The root's model, `provider/id`. */
  model?: string;
  status: NodeStatus;
  /** The root first, then its sub-agents, ended ones included, in the order they started. */
  nodes: StateNode[];
}

export function stateNode(n: RosterNode): StateNode {
  const { id, kind, parent, label, task, depth, access, status, model, thinking, caps, turns, spent, startedAt, endedAt, answer, transcript, pending } = n;
  return { id, kind, parent, label, task, depth, access, status, model, thinking, caps, turns, spent, startedAt, endedAt, answer, transcript, pending };
}

export function writeState(file: string, state: SessionState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readState(file: string): SessionState | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as SessionState;
    return v && v.version === 1 && Array.isArray(v.nodes) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove sub-agent transcripts last written more than `days` ago under `sessionsDir` (and the
 * folders that leaves empty). Only `…/sub/*.jsonl`: a session's own transcript is the user's and
 * stays. 0 keeps everything. Returns how many it removed.
 */
export function pruneSubTranscripts(sessionsDir: string, days: number, now = Date.now()): number {
  if (!(days > 0)) return 0;
  const cutoff = now - days * 86_400_000;
  let removed = 0;
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name === "sub") {
        for (const f of fs.readdirSync(p)) {
          const file = path.join(p, f);
          try {
            if (f.endsWith(".jsonl") && fs.statSync(file).mtimeMs < cutoff) {
              fs.rmSync(file);
              removed++;
            }
          } catch {
            /* gone meanwhile */
          }
        }
        for (const d of [p, dir]) {
          try {
            fs.rmdirSync(d); // only when empty
          } catch {
            break;
          }
        }
      } else if (e.isDirectory() && depth < 2) walk(p, depth + 1);
    }
  };
  walk(sessionsDir, 0);
  return removed;
}
