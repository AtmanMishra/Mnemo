/**
 * AREA 10.1 — the persistent job store: ~/.mnemo/schedules.json.
 *
 * One JSON array of jobs, shared by every surface: the `mnemo schedule` CLI,
 * the daemon, the in-session ticker (schedules-inline.ts) and the tui-go
 * Schedules overlay. The schema must round-trip through BOTH TypeScript and
 * Go (tui-go/internal/schedule), so it stays plain data — no classes, no
 * functions in the file, every optional field omitted when absent.
 *
 * A job is driven by exactly one of:
 *   cron     — 5-field cron expression (10.1 parser)
 *   interval — "30s" | "10m" | "2h" (sea-loop parseInterval)
 *   trigger  — an event type that fires it (10.4): on_failure, on_uncommitted,
 *              on_cost_over, on_push. Triggers share the store; firing is
 *              just runJob(id).
 * plus a prompt (what the one-shot child is told), an optional model override,
 * an optional scope (working directory; default = wherever the runner is),
 * an enabled flag, and last/next run bookkeeping.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseInterval } from "../../bin/sea-loop.ts";
import { cronNext, describeCron } from "./cron.ts";

/** The four trigger types schedules know how to store. */
export const TRIGGER_TYPES = ["on_failure", "on_uncommitted", "on_cost_over", "on_push"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export interface TriggerSpec {
  type: TriggerType;
  /** Type-specific knobs: on_cost_over -> {budget}, all -> {cooldownMs}. */
  params?: Record<string, unknown>;
}

export interface JobResult {
  ok: boolean;
  at: number;
  durationMs?: number;
  detail?: string;
}

export interface ScheduleJob {
  id: string;
  name: string;
  prompt: string;
  cron?: string;
  interval?: string;
  trigger?: TriggerSpec;
  model?: string;
  scope?: string;
  enabled: boolean;
  lastRun?: number | null;
  nextRun?: number | null;
  lastResult?: JobResult | null;
}

export function schedulesPath(home: string): string {
  return path.join(home, ".mnemo", "schedules.json");
}

/** Load the job list. A missing file is an empty store; junk JSON is a throw. */
export function loadJobs(home: string): ScheduleJob[] {
  const file = schedulesPath(home);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (text.trim() === "") return [];
  const raw = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error(`schedules.json: expected a JSON array, got ${typeof raw}`);
  return raw.map(normalizeJob);
}

/** Write the whole job list. Writes via temp file + rename so a reader
 * (daemon, ticker, tui-go overlay) never observes a half-written file. */
export function saveJobs(home: string, jobs: ScheduleJob[]): void {
  const file = schedulesPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Sanity-check one parsed job object; throws on shape violations. */
export function normalizeJob(raw: unknown): ScheduleJob {
  if (typeof raw !== "object" || raw === null) throw new Error(`schedule job: not an object`);
  const o = raw as Record<string, unknown>;
  for (const k of ["id", "name", "prompt"] as const) {
    if (typeof o[k] !== "string" || (o[k] as string).trim() === "") {
      throw new Error(`schedule job: "${k}" must be a non-empty string`);
    }
  }
  const cron = o.cron === undefined ? undefined : String(o.cron);
  const interval = o.interval === undefined ? undefined : String(o.interval);
  const trigger = o.trigger === undefined ? undefined : normalizeTrigger(o.trigger);
  const drive = [cron !== undefined, interval !== undefined, trigger !== undefined].filter(Boolean).length;
  if (drive !== 1) {
    throw new Error(`schedule job "${o.id}": exactly one of cron/interval/trigger is required (got ${drive})`);
  }
  if (cron !== undefined) {
    try {
      parseCronExpr(cron);
    } catch (e) {
      throw new Error(`schedule job "${o.id}": bad cron: ${(e as Error).message}`);
    }
  }
  if (interval !== undefined) {
    try {
      parseInterval(interval);
    } catch (e) {
      throw new Error(`schedule job "${o.id}": bad interval: ${(e as Error).message}`);
    }
  }
  const job: ScheduleJob = {
    id: o.id as string,
    name: o.name as string,
    prompt: o.prompt as string,
    enabled: o.enabled === undefined ? true : Boolean(o.enabled),
  };
  if (cron !== undefined) job.cron = cron;
  if (interval !== undefined) job.interval = interval;
  if (trigger !== undefined) job.trigger = trigger;
  if (typeof o.model === "string" && o.model !== "") job.model = o.model;
  if (typeof o.scope === "string" && o.scope !== "") job.scope = o.scope;
  if (typeof o.lastRun === "number") job.lastRun = o.lastRun;
  if (typeof o.nextRun === "number") job.nextRun = o.nextRun;
  if (o.lastResult !== undefined && o.lastResult !== null) {
    const r = o.lastResult as Record<string, unknown>;
    if (typeof r === "object" && typeof r.ok === "boolean" && typeof r.at === "number") {
      const res: JobResult = { ok: r.ok, at: r.at };
      if (typeof r.durationMs === "number") res.durationMs = r.durationMs;
      if (typeof r.detail === "string") res.detail = r.detail;
      job.lastResult = res;
    }
  }
  return job;
}

function normalizeTrigger(raw: unknown): TriggerSpec {
  if (typeof raw !== "object" || raw === null) throw new Error(`trigger: not an object`);
  const t = raw as Record<string, unknown>;
  if (typeof t.type !== "string" || !(TRIGGER_TYPES as readonly string[]).includes(t.type)) {
    throw new Error(`trigger: unknown type ${JSON.stringify(t.type)}`);
  }
  const spec: TriggerSpec = { type: t.type as TriggerType };
  if (t.params !== undefined && t.params !== null && typeof t.params === "object") {
    spec.params = { ...(t.params as Record<string, unknown>) };
  }
  return spec;
}

/** Parse just for validation (cron.ts's parser is the only grammar). */
function parseCronExpr(expr: string): void {
  cronNext(expr, new Date(2026, 0, 1, 0, 0, 0, 0)); // throw on bad shape
}

/** A fresh job id: slug of the name + a short suffix so two "nightly"s differ. */
export function newJobId(name: string, rng: () => number = Math.random): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "job";
  const suffix = Math.floor(rng() * 0xffff).toString(16).padStart(4, "0");
  return `${slug}-${suffix}`;
}

/** Human schedule description for the job, for listings and the TUI. */
export function describe(job: ScheduleJob): string {
  if (job.trigger) {
    const p = job.trigger.params ?? {};
    const extras: string[] = [];
    if (typeof p.budget === "number") extras.push(`budget $${p.budget}`);
    if (typeof p.cooldownMs === "number") extras.push(`cooldown ${Math.round(p.cooldownMs / 1000)}s`);
    return "on " + job.trigger.type + (extras.length > 0 ? " · " + extras.join(" · ") : "");
  }
  if (job.cron !== undefined) return describeCron(job.cron);
  return "every " + job.interval;
}

/** Period in ms for one full cycle of the job (cron = 1 minute resolution). */
export function periodMs(job: ScheduleJob): number {
  if (job.cron !== undefined) return 60_000;
  if (job.interval !== undefined) return parseInterval(job.interval);
  return 60_000;
}

/** Next fire time (epoch ms) after the given moment, or null if never. */
export function nextRunOf(job: ScheduleJob, now: number): number | null {
  if (job.cron !== undefined) return cronNext(job.cron, now);
  if (job.interval !== undefined) return now + parseInterval(job.interval);
  return null; // triggers are event-driven; nextRun means nothing
}

/**
 * A cron/interval job is due when it is enabled and its nextRun has arrived
 * (or has not been computed yet, e.g. just added while the daemon runs).
 */
export function isDue(job: ScheduleJob, now: number): boolean {
  if (!job.enabled) return false;
  if (job.trigger) return false; // triggers fire on their event, not on time
  return job.nextRun == null || now >= job.nextRun;
}

/** Advance the bookkeeping after a fire. `nextRun` comes from the current
 * moment so a late ticker stays on the calendar rather than catching up. */
export function markRun(job: ScheduleJob, now: number, result?: JobResult): void {
  job.lastRun = now;
  job.nextRun = nextRunOf(job, now);
  job.lastResult = result ?? null;
}

/** Trigger cooldown: default 60s, override via params.cooldownMs. */
export function triggerCooldown(job: ScheduleJob): number {
  const ms = job.trigger?.params?.cooldownMs;
  return typeof ms === "number" && ms > 0 ? ms : 60_000;
}

/** A trigger may fire if its cooldown since the last fire has elapsed. */
export function triggerReady(job: ScheduleJob, now: number): boolean {
  if (!job.enabled) return false;
  if (!job.trigger) return false;
  if (job.lastRun == null) return true;
  return now - job.lastRun >= triggerCooldown(job);
}