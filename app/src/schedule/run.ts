/**
 * Running scheduled jobs. A job is `mnemo -p` in a child process, so the permission gate, the
 * managed policy and every setting apply as they do to any other run. `-p` allows what would
 * ask, so an unattended run is read-only (`--plan`) unless the job says `actions`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { redact } from "@mnemo/memory";
import { selfCommand } from "../runtime/self.ts";
import { cronNext, parseCron } from "./cron.ts";
import { DEFAULT_TIMEOUT_MIN, loadJobs, saveJobs, type Job } from "./store.ts";

const KEEP_LOGS = 20;

export function logDir(home: string, name: string): string {
  return path.join(home, "schedules", "logs", name);
}

/** The job's next run after its last one (or its creation). A window missed while off fires once, not once per miss. */
export function nextRun(job: Job): Date | undefined {
  return cronNext(parseCron(job.cron), new Date(job.lastRun ?? job.created));
}

export function isDue(job: Job, now: number): boolean {
  if (!job.enabled) return false;
  const next = nextRun(job);
  return next !== undefined && next.getTime() <= now;
}

export function jobArgs(job: Job): string[] {
  return [...selfCommand(), "-p", job.prompt, "--cwd", job.cwd, "--no-reflect", ...(job.actions ? [] : ["--plan"])];
}

function prune(dir: string): void {
  const files = fs.readdirSync(dir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_LOGS))) fs.rmSync(path.join(dir, f), { force: true });
}

/** Runs one job now. `lastRun` is stored first, so a crash mid-run cannot make the next tick start it again. */
export async function runJob(home: string, name: string, argv: (job: Job) => string[] = jobArgs): Promise<{ code: number; log: string }> {
  const jobs = loadJobs(home);
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`no job named "${name}"`);
  job.lastRun = Date.now();
  saveJobs(home, jobs);

  const dir = logDir(home, job.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = path.join(dir, `${new Date(job.lastRun).toISOString().replace(/[:.]/g, "-")}.log`);
  let out = "";
  let code: number;
  try {
    const proc = Bun.spawn(argv(job), { cwd: job.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), (job.timeout ?? DEFAULT_TIMEOUT_MIN) * 60_000);
    const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    code = await proc.exited;
    clearTimeout(timer);
    out = o + (e ? `\n--- stderr ---\n${e}` : "");
  } catch (err) {
    code = 1;
    out = `could not start: ${(err as Error).message}`;
  }
  fs.writeFileSync(log, redact(`# ${job.name} ${new Date(job.lastRun).toISOString()} exit ${code}\n${out}`), { mode: 0o600 });
  prune(dir);
  return { code, log };
}

/** Runs every job that is due, one after another. Returns the names it ran. */
export async function tick(home: string, now = Date.now(), run = runJob): Promise<string[]> {
  const ran: string[] = [];
  for (const job of loadJobs(home)) {
    if (!isDue(job, now)) continue;
    await run(home, job.name);
    ran.push(job.name);
  }
  return ran;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One scheduler at a time: a lock file holding the pid, taken over only when that process is gone. */
export function takeLock(home: string): (() => void) | undefined {
  const file = path.join(home, "schedules", "daemon.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => fs.rmSync(file, { force: true });
    } catch {
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && alive(pid)) return undefined;
      fs.rmSync(file, { force: true });
    }
  }
  return undefined;
}

/** Checks every 30 seconds until stopped. */
export async function daemon(home: string, stop: AbortSignal, log: (line: string) => void): Promise<number> {
  const release = takeLock(home);
  if (!release) return log("another scheduler is already running"), 1;
  try {
    while (!stop.aborted) {
      for (const name of await tick(home)) log(`ran ${name}`);
      await new Promise((r) => {
        const t = setTimeout(r, 30_000);
        stop.addEventListener("abort", () => (clearTimeout(t), r(null)), { once: true });
      });
    }
  } finally {
    release();
  }
  return 0;
}
