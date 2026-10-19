/**
 * Scheduled jobs live only in `$MNEMO_HOME/schedules.json`, the user's own file: a folder
 * cannot add a job, so a repository cannot make this machine run a prompt on a timer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseCron } from "./cron.ts";

export interface Job {
  name: string;
  cron: string;
  prompt: string;
  /** Absolute folder the run starts in. */
  cwd: string;
  /** Without this a run is read-only (`--plan`); with it the run may edit and run commands under the normal gate. */
  actions?: boolean;
  /** Minutes before the run is stopped. */
  timeout?: number;
  enabled: boolean;
  created: number;
  lastRun?: number;
}

export const DEFAULT_TIMEOUT_MIN = 30;

export function schedulesPath(home: string): string {
  return path.join(home, "schedules.json");
}

export function loadJobs(home: string): Job[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(schedulesPath(home), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const jobs: Job[] = [];
  for (const j of raw as Partial<Job>[]) {
    if (typeof j?.name !== "string" || typeof j.cron !== "string" || typeof j.prompt !== "string" || typeof j.cwd !== "string") continue;
    try {
      parseCron(j.cron);
    } catch {
      continue;
    }
    jobs.push({ name: j.name, cron: j.cron, prompt: j.prompt, cwd: j.cwd, actions: j.actions === true, timeout: typeof j.timeout === "number" ? j.timeout : undefined, enabled: j.enabled !== false, created: typeof j.created === "number" ? j.created : Date.now(), lastRun: typeof j.lastRun === "number" ? j.lastRun : undefined });
  }
  return jobs;
}

export function saveJobs(home: string, jobs: Job[]): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = schedulesPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function validName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}
