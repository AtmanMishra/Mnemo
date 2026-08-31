/**
 * AREA 10.2/10.4 — `mnemo schedule ...` CLI commands.
 *
 * Mirrors the traces/consolidate/auth subcommands: local file work, no
 * provider, no LLM, no network. Injected home/env/cwd/io so every branch is
 * script-testable with a temp HOME (HANDOFF §6.3). Commands:
 *
 *   mnemo schedule list
 *   mnemo schedule add --prompt P [--name N] [--cron EXPR | --interval 30m]
 *                      [--model M] [--scope DIR] [--id ID]
 *   mnemo schedule rm <id>
 *   mnemo schedule pause <id> | resume <id>
 *   mnemo schedule fire <id>            (the /now path; spawns a real child)
 *   mnemo schedule daemon [--once] [--max-runs N]
 *   mnemo schedule trigger add --type on_failure|on_uncommitted|on_cost_over|on_push
 *                     --prompt P [--name N] [--scope DIR] [--id ID]
 *                     [--budget $N] [--cooldown-ms N]
 *   mnemo schedule trigger rm|pause|resume <id>
 */
import { fireNow, tickAll, childEnv } from "./daemon.ts";
import { parseInterval } from "../../bin/sea-loop.ts";
import { parseCron } from "./cron.ts";
import {
  loadJobs, saveJobs, newJobId, describe, periodMs, normalizeJob,
  type ScheduleJob, type TriggerType, TRIGGER_TYPES,
} from "./store.ts";

export interface CliOptions {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  argv: string[];
  log: (s: string) => void;
  err: (s: string) => void;
  /** Deterministic id rng; default Math.random. */
  rng?: () => number;
  runChild?: (job: ScheduleJob) => Promise<{ ok: boolean; at: number; durationMs?: number; detail?: string }>;
}

class UsageError extends Error {}

/** `mnemo schedule <sub> ...` — returns the process exit code. */
export async function runSchedule(args: string[], o: CliOptions): Promise<number> {
  const sub = args[0] ?? "list";
  try {
    switch (sub) {
      case "list": return cmdList(o);
      case "daemon": return await cmdDaemon(args.slice(1), o);
      case "fire": return await cmdFire(args.slice(1), o);
      case "rm": return cmdRm(args.slice(1), o);
      case "pause": return cmdPause(args.slice(1), false, o);
      case "resume": return cmdPause(args.slice(1), true, o);
      case "add": return cmdAdd(args.slice(1), o);
      case "trigger": return await cmdTrigger(args.slice(1), o);
      default:
        throw new UsageError(`unknown schedule subcommand "${sub}" — list|add|rm|pause|resume|fire|daemon|trigger`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      o.err(`schedule: ${e.message}`);
      return 2;
    }
    o.err(`schedule: ${(e as Error).message}`);
    return 1;
  }
}

function cmdList(o: CliOptions): number {
  const jobs = loadJobs(o.home);
  if (jobs.length === 0) {
    o.log("(no schedules yet — `mnemo schedule add --cron \"0 9 * * *\" --prompt \"…\"`)");
    return 0;
  }
  for (const line of listBody(jobs)) o.log(line);
  return 0;
}

/** The same row model the TUI overlay and in-session /schedule use. */
export function listBody(jobs: ScheduleJob[]): string[] {
  if (jobs.length === 0) return [];
  const width = Math.max(...jobs.map((j) => j.name.length));
  return jobs.map((job) => {
    const mark = job.enabled ? "on " : "off";
    const sched = describe(job);
    const last = job.lastRun != null
      ? new Date(job.lastRun).toISOString().slice(0, 16).replace("T", " ")
      : "never";
    const result = job.lastResult ? (job.lastResult.ok ? "ok" : "failed") : "-";
    const next = job.trigger
      ? "event"
      : job.nextRun != null
        ? new Date(job.nextRun).toISOString().slice(0, 16).replace("T", " ")
        : "-";
    return `${job.id.padEnd(Math.max(job.id.length, 28))} ${mark.padEnd(3)} ${job.name.padEnd(width)}  ${sched}  next ${next}  last ${last} ${result}`;
  });
}

function cmdDaemon(args: string[], o: CliOptions): Promise<number> {
  const once = args.includes("--once");
  const maxRuns = parseIntFlag(args, "--max-runs");
  if (once) {
    return tickAll(ctxFor(o)).then(() => 0);
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  // import is cheap; runDaemon lives in daemon.ts
  return import("./daemon.ts").then(async ({ runDaemon }) => {
    await runDaemon({
      home: o.home,
      cwd: o.cwd,
      env: o.env,
      maxRuns,
      signal: controller.signal,
      runChild: o.runChild,
      log: (m) => o.log(m),
    });
    return 0;
  });
}

function ctxFor(o: CliOptions) {
  return {
    home: o.home,
    cwd: o.cwd,
    env: o.env,
    runChild: o.runChild,
    log: (m: string) => o.log(m),
  };
}

async function cmdFire(args: string[], o: CliOptions): Promise<number> {
  const id = args[0];
  if (!id) throw new UsageError("fire needs a job id — `mnemo schedule list`");
  const jobs = loadJobs(o.home);
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new UsageError(`no job "${id}"`);
  const outcome = await fireNow(job, ctxFor(o));
  if (outcome === "disabled") { o.err(`${job.name}: job is paused — resume it first`); return 1; }
  o.log(`${job.name}: ${outcome}`);
  return 0;
}

function cmdRm(args: string[], o: CliOptions): number {
  const id = args[0];
  if (!id) throw new UsageError("rm needs a job id");
  const jobs = loadJobs(o.home);
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) throw new UsageError(`no job "${id}"`);
  saveJobs(o.home, next);
  o.log(`removed ${id}`);
  return 0;
}

function cmdPause(args: string[], enable: boolean, o: CliOptions): number {
  const id = args[0];
  if (!id) throw new UsageError(`${enable ? "resume" : "pause"} needs a job id`);
  const jobs = loadJobs(o.home);
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new UsageError(`no job "${id}"`);
  job.enabled = enable;
  saveJobs(o.home, jobs);
  o.log(`${job.name}: ${enable ? "resumed" : "paused"}`);
  return 0;
}

function cmdAdd(args: string[], o: CliOptions): number {
  const prompt = flag(args, "--prompt");
  if (!prompt) throw new UsageError("add needs --prompt \"…\"");
  const cron = flag(args, "--cron");
  const interval = flag(args, "--interval");
  if (cron && interval) throw new UsageError("give --cron OR --interval, not both");
  const drive = cron ?? interval;
  if (!drive) throw new UsageError("add needs --cron \"0 9 * * *\" or --interval \"30m\"");
  const name = flag(args, "--name") ?? inferName(prompt);
  const job: ScheduleJob = {
    id: flag(args, "--id") ?? newJobId(name, o.rng ?? Math.random),
    name,
    prompt,
    enabled: true,
  };
  if (cron) {
    try {
      parseCron(cron); // validate before anything touches the store
    } catch (e) {
      throw new UsageError(`bad cron: ${(e as Error).message}`);
    }
    job.cron = cron;
  }
  if (interval) {
    parseInterval(interval); // throw early on junk
    job.interval = interval;
  }
  const model = flag(args, "--model");
  if (model) job.model = model;
  const scope = flag(args, "--scope");
  if (scope) job.scope = scope;
  const jobs = loadJobs(o.home);
  if (jobs.some((j) => j.id === job.id)) throw new UsageError(`a job "${job.id}" already exists`);
  jobs.push(job);
  saveJobs(o.home, jobs);
  o.log(`added ${job.id} (${name}) — ${describe(job)}`);
  return 0;
}

/** `mnemo schedule trigger <sub> ...` — triggers share the job store. */
async function cmdTrigger(args: string[], o: CliOptions): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": {
      const jobs = loadJobs(o.home).filter((j) => j.trigger);
      if (jobs.length === 0) {
        o.log("(no triggers yet — `mnemo schedule trigger add --type on_failure --prompt \"…\"`)");
        return 0;
      }
      for (const line of listBody(jobs)) o.log(line);
      return 0;
    }
    case "rm": {
      const id = args[1];
      if (!id) throw new UsageError("trigger rm needs a job id");
      const jobs = loadJobs(o.home);
      const next = jobs.filter((j) => j.id !== id);
      if (next.length === jobs.length) throw new UsageError(`no job "${id}"`);
      saveJobs(o.home, next);
      o.log(`removed ${id}`);
      return 0;
    }
    case "pause": case "resume": {
      const enable = sub === "resume";
      const id = args[1];
      if (!id) throw new UsageError(`trigger ${sub} needs a job id`);
      const jobs = loadJobs(o.home);
      const job = jobs.find((j) => j.id === id);
      if (!job) throw new UsageError(`no job "${id}"`);
      job.enabled = enable;
      saveJobs(o.home, jobs);
      o.log(`${job.name}: ${enable ? "resumed" : "paused"}`);
      return 0;
    }
    case "add": return cmdTriggerAdd(args.slice(1), o);
    case "fire": return cmdFire(args.slice(1), o);
    default:
      throw new UsageError(`unknown trigger subcommand "${sub}" — list|add|rm|pause|resume|fire`);
  }
}

function cmdTriggerAdd(args: string[], o: CliOptions): number {
  const type = flag(args, "--type");
  if (!type || !(TRIGGER_TYPES as readonly string[]).includes(type)) {
    throw new UsageError(`trigger add needs --type ${TRIGGER_TYPES.join("|")}`);
  }
  const prompt = flag(args, "--prompt");
  if (!prompt) throw new UsageError("trigger add needs --prompt \"…\"");
  const name = flag(args, "--name") ?? inferName(prompt);
  const job: ScheduleJob = {
    id: flag(args, "--id") ?? newJobId(name, o.rng ?? Math.random),
    name,
    prompt,
    trigger: { type: type as TriggerType },
    enabled: true,
  };
  const budget = flag(args, "--budget");
  if (budget !== null) {
    const n = Number(budget);
    if (!(n > 0)) throw new UsageError("--budget must be a positive number (USD)");
    job.trigger!.params = { ...(job.trigger!.params ?? {}), budget: n };
  }
  const cooldown = flag(args, "--cooldown-ms");
  if (cooldown !== null) {
    const n = Number(cooldown);
    if (!(n > 0)) throw new UsageError("--cooldown-ms must be a positive number");
    job.trigger!.params = { ...(job.trigger!.params ?? {}), cooldownMs: n };
  }
  const scope = flag(args, "--scope");
  if (scope) job.scope = scope;
  const model = flag(args, "--model");
  if (model) job.model = model;
  const jobs = loadJobs(o.home);
  if (jobs.some((j) => j.id === job.id)) throw new UsageError(`a job "${job.id}" already exists`);
  jobs.push(job);
  saveJobs(o.home, jobs);
  o.log(`added trigger ${job.id} (${name}) — ${type}`);
  return 0;
}

function inferName(prompt: string): string {
  const m = /^(\S+)/.exec(prompt.trim());
  return (m?.[1] ?? "job").slice(0, 24).toLowerCase();
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function parseIntFlag(args: string[], name: string): number | undefined {
  const v = flag(args, name);
  if (v === null) return undefined;
  const n = Number(v);
  return n >= 1 ? n : undefined;
}

export { childEnv, normalizeJob, periodMs };
export type { TriggerType };