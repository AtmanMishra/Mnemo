/**
 * Background memory work: what ran, when, and what it found, as plain files under
 * `$MNEMO_HOME/background/` that any Mnemo process (or a person with `cat`) can read:
 *
 *   state.json     when each task last ran, and what tidy and curate last reported
 *   events.jsonl   one line per result, newest last; open conversations read it to
 *                  learn what changed since their last turn
 *   run.lock       held by the one process running tasks; the rest leave it alone
 *
 * Only the process holding the lock writes either file, so appends never interleave.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const TASKS = ["ingest", "tidy", "curate"] as const;
export type Task = (typeof TASKS)[number];

export interface BackgroundEvent {
  id: string;
  at: number;
  task: Task;
  /** One line, for a person: "learned 3 facts from 2 Claude Code sessions". */
  text: string;
  items: string[];
  /** The project it is about (`projectIdentity(..).id`); none means every project. */
  project?: string;
  /** The project's folder name, for display. */
  name?: string;
  /** The task failed; shown by `mnemo background`, never to a conversation. */
  failed?: boolean;
}

export interface RunState {
  /** When each task last ran (or failed). */
  last: Partial<Record<Task, number>>;
  /** What tidy and curate last reported, per project: the same findings are not announced twice. */
  reported: Record<string, string>;
}

/** Events kept: older ones are dropped when the file passes `MAX_EVENTS` lines. */
export const MAX_EVENTS = 200;
const KEEP_EVENTS = 100;

export const backgroundDir = (home: string) => path.join(home, "background");
export const eventsFile = (home: string) => path.join(backgroundDir(home), "events.jsonl");
export const stateFile = (home: string) => path.join(backgroundDir(home), "state.json");
export const lockFile = (home: string) => path.join(backgroundDir(home), "run.lock");

export function loadState(home: string): RunState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(home), "utf8")) as Partial<RunState>;
    return { last: raw.last && typeof raw.last === "object" ? raw.last : {}, reported: raw.reported && typeof raw.reported === "object" ? raw.reported : {} };
  } catch {
    return { last: {}, reported: {} };
  }
}

export function saveState(home: string, state: RunState): void {
  fs.mkdirSync(backgroundDir(home), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, stateFile(home));
}

const TASK_SET = new Set<string>(TASKS);

function parseEvent(line: string): BackgroundEvent | undefined {
  try {
    const e = JSON.parse(line) as Partial<BackgroundEvent>;
    if (typeof e.id !== "string" || typeof e.at !== "number" || !TASK_SET.has(String(e.task)) || typeof e.text !== "string") return undefined;
    return {
      id: e.id,
      at: e.at,
      task: e.task as Task,
      text: e.text,
      items: Array.isArray(e.items) ? e.items.filter((i): i is string => typeof i === "string") : [],
      project: typeof e.project === "string" ? e.project : undefined,
      name: typeof e.name === "string" ? e.name : undefined,
      failed: e.failed === true ? true : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Every event kept, oldest first. A line being written, or one that is not an event, is skipped. */
export function readEvents(home: string): BackgroundEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(eventsFile(home), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((l) => (l.trim() ? (parseEvent(l) ?? []) : []));
}

/** Append events (the caller holds the run lock), dropping the oldest once there are too many. */
export function appendEvents(home: string, events: BackgroundEvent[]): void {
  if (!events.length) return;
  fs.mkdirSync(backgroundDir(home), { recursive: true, mode: 0o700 });
  fs.appendFileSync(eventsFile(home), events.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
  const all = readEvents(home);
  if (all.length <= MAX_EVENTS) return;
  const tmp = `${eventsFile(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, all.slice(-KEEP_EVENTS).map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
  fs.renameSync(tmp, eventsFile(home));
}
