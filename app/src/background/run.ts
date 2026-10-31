/**
 * The background tasks, run by whichever process holds the run lock (`mnemo background run`,
 * which an open Mnemo starts when the `background` setting is on and a task is due):
 *
 *   ingest   learn from Claude Code sessions that are new or grew since the last ingest,
 *            the same as `mnemo memory ingest` (facts only: a skill stays a candidate)
 *   tidy     what `mnemo memory tidy` would retire in recently used projects; reported only
 *   curate   personal skills `mnemo memory curate` would archive; reported only
 *
 * Tidy and curate change nothing: they say what they found once, and again only when it
 * changes. Every result is an event (store.ts) that open conversations pick up.
 */
import { acquireLock, curateSkills, ingestClaudeCode, planTidy, projectIdentity, redact, type MemoryService, type Reflector } from "@mnemo/memory";
import * as fs from "node:fs";
import { appendEvents, backgroundDir, loadState, lockFile, saveState, TASKS, type BackgroundEvent, type RunState, type Task } from "./store.ts";

/** A run that has held the lock this long without its process is abandoned. */
const LOCK_STALE_MS = 3 * 60 * 60_000;
/** Items one event carries. */
const MAX_ITEMS = 8;

export interface RunOptions {
  home: string;
  /** Minutes between runs of a task. */
  everyMin: number;
  /** Run every task now, due or not (`mnemo background run --force`). */
  force?: boolean;
  now?: () => number;
  memory: MemoryService;
  /** The reflection model call; absent when no model is usable (`noModel` says why). */
  reflect?: Reflector;
  noModel?: string;
  userSkillsDir: string;
  /** Folders worked in lately: tidy looks at their projects. */
  projects: () => Promise<string[]>;
  /** Claude Code's projects folder (tests). */
  claudeProjectsDir?: string;
}

export interface RunResult {
  /** Another process holds the lock: nothing ran. */
  busy?: boolean;
  ran: Task[];
  events: BackgroundEvent[];
}

export function isDue(state: RunState, task: Task, everyMin: number, now: number): boolean {
  const last = state.last[task];
  return last === undefined || now - last >= everyMin * 60_000;
}

export function dueTasks(state: RunState, everyMin: number, now: number): Task[] {
  return TASKS.filter((t) => isDue(state, t, everyMin, now));
}

let seq = 0;
const eventId = (at: number) => `${at.toString(36)}-${process.pid.toString(36)}-${(seq++).toString(36)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (items: string[]) => (items.length > MAX_ITEMS ? [...items.slice(0, MAX_ITEMS), `… and ${items.length - MAX_ITEMS} more`] : items);

export async function runBackground(o: RunOptions): Promise<RunResult> {
  const now = o.now ?? Date.now;
  fs.mkdirSync(backgroundDir(o.home), { recursive: true, mode: 0o700 });
  const release = await acquireLock(lockFile(o.home), { staleMs: LOCK_STALE_MS });
  if (!release) return { busy: true, ran: [], events: [] };
  try {
    const state = loadState(o.home);
    const tasks = o.force ? [...TASKS] : dueTasks(state, o.everyMin, now());
    const result: RunResult = { ran: [], events: [] };
    for (const task of tasks) {
      let found: Omit<BackgroundEvent, "id" | "at">[];
      try {
        found = await TASK_RUNNERS[task](o, state);
      } catch (error) {
        found = [{ task, text: `failed: ${redact(error instanceof Error ? error.message : String(error))}`, items: [], failed: true }];
      }
      // Stamped after the task, so a conversation that read the events while it ran still sees these.
      const at = now();
      state.last[task] = at;
      const events = found.map((e) => ({ ...e, items: clip(e.items.map(redact)), id: eventId(at), at }));
      // Saved after each task: a crash in the next one must not make this one run again at once.
      saveState(o.home, state);
      appendEvents(o.home, events);
      result.ran.push(task);
      result.events.push(...events);
    }
    return result;
  } finally {
    release();
  }
}

type Found = Omit<BackgroundEvent, "id" | "at">;

const TASK_RUNNERS: Record<Task, (o: RunOptions, state: RunState) => Promise<Found[]>> = {
  async ingest(o) {
    if (!o.reflect) throw new Error(o.noModel ?? "no model to learn with");
    const byProject = new Map<string, { name: string; sessions: Set<string>; items: string[] }>();
    let current: { name: string; sessions: Set<string>; items: string[] } | undefined;
    await ingestClaudeCode({
      memory: o.memory,
      home: o.home,
      userSkillsDir: o.userSkillsDir,
      reflect: o.reflect,
      projectsDir: o.claudeProjectsDir,
      progress: (s) => {
        const id = projectIdentity(s.cwd);
        current = byProject.get(id.id) ?? { name: id.name, sessions: new Set(), items: [] };
        byProject.set(id.id, current);
        current.sessions.add(s.id);
      },
      notify: (_session, note) => {
        if (!current) return;
        if (note.kind === "learned") current.items.push(...note.items);
        else if (note.kind === "skill") current.items.push(note.text);
      },
    });
    return [...byProject].map(([project, p]) => ({
      task: "ingest" as const,
      project,
      name: p.name,
      text: `learned ${p.items.length ? `${plural(p.items.length, "fact")} ` : ""}from ${plural(p.sessions.size, "Claude Code session")}`,
      items: p.items,
    }));
  },

  async tidy(o, state) {
    const out: Found[] = [];
    const seen = new Set<string>();
    for (const folder of await o.projects()) {
      const id = projectIdentity(folder);
      if (seen.has(id.id)) continue;
      seen.add(id.id);
      const plan = await planTidy(o.memory, id.id, id.root);
      const items = plan.map((p) => `${p.why}: ${p.what}`);
      const key = `tidy:${id.id}`;
      const print = items.join("\n");
      if (print === (state.reported[key] ?? "")) continue;
      state.reported[key] = print;
      if (!plan.length) continue;
      out.push({
        task: "tidy",
        project: id.id,
        name: id.name,
        text: `${plural(plan.length, "fact")} in ${id.name}'s memory could be retired (\`mnemo memory tidy --cwd ${id.root} --apply\` retires them)`,
        items,
      });
    }
    return out;
  },

  async curate(o, state) {
    const report = await curateSkills({ memory: o.memory, userSkillsDir: o.userSkillsDir, apply: false });
    const old = report.filter((r) => r.state === "archive" && r.scope === "user");
    const items = old.map((r) => `${r.name} (last used ${r.lastUsed})`);
    const print = old.map((r) => r.name).join("\n");
    if (print === (state.reported.curate ?? "")) return [];
    state.reported.curate = print;
    if (!old.length) return [];
    return [{ task: "curate", text: `${plural(old.length, "personal skill")} unused for 90 days (\`mnemo memory curate --apply\` moves them to skills-archive)`, items }];
  },
};
