/**
 * AREA 10.2 — the schedule daemon: one long-lived process that fires due jobs.
 *
 * Built on the sea-loop primitives: each job gets its own runScheduler loop
 * (immediate first tick, then one tick per period — a minute for cron, the
 * interval for interval jobs), and each tick runs the same pure `tick()`
 * every surface shares: daemon, in-session ticker (schedules-inline.ts), and
 * the trigger evaluators. The child spawn is abstracted behind an injected
 * runner exactly like sea-loop, so NOTHING here touches the CLI, an LLM, or
 * even a real process unless a test opts into a probe CLI.
 *
 * Fire protocol (the double-fire defence, see lease.ts):
 *   1. acquire the lease (O_EXCL + pid + stale detection);
 *   2. lost the lease → skip this window entirely (the other host fired);
 *   3. won it → advance the bookkeeping FIRST (lastRun/nextRun persisted
 *      before the child runs, so a ticker that read "due" a moment ago and
 *      then checks the store sees nextRun in the future and backs off);
 *   4. run the child; record lastResult; release the lease.
 */
import * as path from "node:path";
import { spawn } from "node:child_process";
import { runScheduler, parseInterval } from "../../bin/sea-loop.ts";
import { acquireLease, releaseLease, releaseOwnLeases } from "./lease.ts";
import {
  loadJobs, saveJobs, isDue, triggerReady, triggerCooldown,
  periodMs, markRun, type ScheduleJob, type JobResult,
} from "./store.ts";

/** Today's accumulated cost in trace dollars (llm span `cost` attrs). */
export function costToday(home: string, readSpans?: (home: string) => any[]): number {
  // imported lazily to keep this module decoupled for tests that fake readSpans
  if (!readSpans) return 0;
  const spans = readSpans(home);
  let total = 0;
  for (const s of spans) {
    if (s.kind !== "llm") continue;
    const c = s.attrs?.cost;
    if (typeof c === "number" && Number.isFinite(c)) total += c;
  }
  return total;
}

/** Cheap, honest git dirtiness probe: any non-empty `git status --porcelain`
 * output in the job's scope counts. The command is injected so tests never
 * touch a real repo (HANDOFF §6.4). */
export async function gitDirty(scope: string, run = gitStatusPorcelain): Promise<boolean> {
  try {
    return (await run(scope)).trim() !== "";
  } catch {
    return false; // no repo (or git missing) is not "uncommitted"
  }
}

function gitStatusPorcelain(scope: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", scope, "status", "--porcelain"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("exit", () => resolve(out));
    child.on("error", () => resolve(""));
  });
}

export interface FireContext {
  home: string;
  cwd: string;
  /** Where the one-shot child lives; MNEMO_AGENT_BIN overrides it. */
  cli?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  load?: () => ScheduleJob[];
  save?: (jobs: ScheduleJob[]) => void;
  acquire?: (jobId: string, holdMs: number) => boolean;
  release?: (jobId: string) => void;
  /** The child runner. Default spawns `node mnemo.ts "<prompt>"` just like
   * sea-loop does, so a scheduled run inherits the FULL environment —
   * MNEMO_MEMORY_JOURNAL, provider keys, approval mode. Injected in tests. */
  runChild?: (job: ScheduleJob) => Promise<JobResult>;
  /** Today's trace-cost reading; injected (defaults to real readSpans). */
  costToday?: (home: string) => number | Promise<number>;
  /** git status --porcelain runner; injected (defaults to real git). */
  gitRunner?: (scope: string) => Promise<string>;
  /** costToday's span source; injected so tests never read real logs. */
  costReader?: (home: string) => any[];
  /** Called when the ticker/daemon stops so it can give its leases back. */
  onStop?: () => void;
  log?: (msg: string) => void;
}

export type TickOutcome = "fired" | "skipped" | "not-due" | "disabled" | "lease-held";

/** One scheduler tick for one job. Pure with respect to FireContext. */
export async function tick(job: ScheduleJob, ctx: FireContext): Promise<TickOutcome> {
  const now = ctx.now ?? Date.now;
  const log = ctx.log ?? (() => {});
  if (!job.enabled) return "disabled";

  // Trigger jobs are event-driven: this tick only evaluates the two
  // pollable ones (git dirty, cost over budget). on_failure fires from a
  // turn_end listener; on_push needs a webhook listener (deferred, 10.4).
  if (job.trigger) {
    const ready = triggerReady(job, now());
    if (!ready) return "skipped";
    const type = job.trigger.type;
    if (type === "on_uncommitted") {
      const scope = job.scope ?? ctx.cwd;
      if (!(await gitDirty(scope, ctx.gitRunner))) return "not-due";
    } else if (type === "on_cost_over") {
      const budget = typeof job.trigger.params?.budget === "number" ? (job.trigger.params.budget as number) : 0;
      if (budget <= 0) return "not-due"; // no budget configured → cannot be over it
      const readCost = ctx.costToday ?? ((home: string) => costToday(home, ctx.costReader));
      const spent = await readCost(ctx.home);
      if (!(spent >= budget)) return "not-due";
    } else {
      return "not-due"; // on_failure/on_push: fired by their own listeners
    }
    return fireNow(job, ctx, "trigger");
  }

  if (!isDue(job, now())) return "not-due";

  const hold = Math.max(periodMs(job), 60_000);
  const acquire = ctx.acquire ?? ((jobId: string, holdMs: number) => acquireLease({ home: ctx.home, jobId, holdMs, now }));
  if (!acquire(job.id, hold)) {
    log(`[schedule] ${job.name} — lease held by another host; skipping this window`);
    return "lease-held";
  }
  // Persist the advance BEFORE the child runs: any other ticker that read
  // "due" moments ago must see nextRun already moved.
  const jobs = (ctx.load ?? (() => loadJobs(ctx.home)))();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    markRun(jobs[idx]!, now(), undefined);
    (ctx.save ?? ((list) => saveJobs(ctx.home, list)))(jobs);
  }
  const result = await (ctx.runChild ?? defaultChild)(job);
  const jobs2 = (ctx.load ?? (() => loadJobs(ctx.home)))();
  const idx2 = jobs2.findIndex((j) => j.id === job.id);
  if (idx2 >= 0) {
    markRun(jobs2[idx2]!, now(), result);
    (ctx.save ?? ((list) => saveJobs(ctx.home, list)))(jobs2);
  }
  // Deliberately do NOT release the lease here: it must stay held through
  // the whole period so a second host ticking the same due window cannot
  // double-fire. The same pid re-acquires (refresh) next period; leases are
  // given back only when the ticker/daemon stops (onStop) and stolen when
  // the holder dies.
  log(`[schedule] ${job.name} — ${result.ok ? "ok" : "failed"}${result.durationMs !== undefined ? ` in ${result.durationMs}ms` : ""}`);
  return "fired";
}

/** Fire a job immediately (the /now path) with the same lease protocol,
 * gated by trigger cooldown when it is a trigger job. */
export async function fireNow(job: ScheduleJob, ctx: FireContext, reason = "now"): Promise<TickOutcome> {
  const now = ctx.now ?? Date.now;
  if (!job.enabled) return "disabled";
  if (job.trigger && !triggerReady(job, now())) return "skipped";
  const hold = job.trigger ? triggerCooldown(job) : Math.max(periodMs(job), 60_000);
  const acquire = ctx.acquire ?? ((jobId: string, holdMs: number) => acquireLease({ home: ctx.home, jobId, holdMs, now }));
  if (!acquire(job.id, hold)) return "lease-held";
  const jobs = (ctx.load ?? (() => loadJobs(ctx.home)))();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    markRun(jobs[idx]!, now(), undefined);
    (ctx.save ?? ((list) => saveJobs(ctx.home, list)))(jobs);
  }
  const result = await (ctx.runChild ?? defaultChild)(job);
  const jobs2 = (ctx.load ?? (() => loadJobs(ctx.home)))();
  const idx2 = jobs2.findIndex((j) => j.id === job.id);
  if (idx2 >= 0) {
    markRun(jobs2[idx2]!, now(), result);
    (ctx.save ?? ((list) => saveJobs(ctx.home, list)))(jobs2);
  }
  // Same hold-through-the-window rule as tick(): the lease stays until the
  // ticker stops or the holder dies.
  return "fired";
}

/** The real child: `node mnemo.ts "<prompt>"` with the full environment, so
 * the shared memory journal, provider keys and approval mode all carry into
 * the one-shot session. MNEMO_SCHEDULE_JOB/NAME tag the run; a model override
 * forces MNEMO_MODEL for the child only. */
export function childEnv(job: ScheduleJob, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.MNEMO_SCHEDULE_JOB = job.id;
  env.MNEMO_SCHEDULE_NAME = job.name;
  if (job.model) env.MNEMO_MODEL = job.model;
  return env;
}

export const defaultChild = async (job: ScheduleJob, env = process.env, cwd = process.cwd(), cli = defaultCli()): Promise<JobResult> => {
  const started = Date.now();
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [cli, job.prompt], {
      env: childEnv(job, env),
      cwd: job.scope || cwd,
      stdio: "inherit",
    });
    child.on("exit", (c) => resolve(c));
    child.on("error", () => resolve(null));
  });
  const result: JobResult = { ok: code === 0, at: Date.now(), durationMs: Date.now() - started };
  if (code === null) result.detail = "spawn failed";
  return result;
};

export function defaultCli(): string {
  return process.env.MNEMO_AGENT_BIN ?? process.env.SEA_AGENT_BIN ?? path.join(import.meta.dirname ?? ".", "..", "..", "bin", "mnemo.ts");
}

export interface DaemonOptions {
  home: string;
  cwd: string;
  maxRuns?: number;
  signal?: AbortSignal;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  load?: () => ScheduleJob[];
  save?: (jobs: ScheduleJob[]) => void;
  runChild?: (job: ScheduleJob) => Promise<JobResult>;
  gitRunner?: (scope: string) => Promise<string>;
  costReader?: (home: string) => any[];
  log?: (msg: string) => void;
}

/** Run one tick of every enabled job (a single pass; `--once`). */
export async function tickAll(ctx: FireContext): Promise<TickOutcome[]> {
  const jobs = (ctx.load ?? (() => loadJobs(ctx.home)))();
  const out: TickOutcome[] = [];
  for (const job of jobs) {
    out.push(await tick(job, ctx));
  }
  return out;
}

/**
 * Per-job periodic loops until every loop exits or the signal aborts. A
 * cron job wakes once a minute; an interval job wakes on its own period,
 * so a 30s schedule is honoured without a wasteful 1-second master tick.
 * Returns per-job run counts.
 */
export async function runDaemon(opts: DaemonOptions): Promise<Record<string, number>> {
  const inFlight = new Set<string>();
  const baseChild = opts.runChild ?? defaultChild;
  const runChildProxy = async (job: ScheduleJob) => {
    inFlight.add(job.id);
    try {
      return await baseChild(job);
    } finally {
      inFlight.delete(job.id);
    }
  };
  const ctx: FireContext = {
    home: opts.home,
    cwd: opts.cwd,
    env: opts.env,
    now: opts.now,
    load: opts.load,
    save: opts.save,
    runChild: runChildProxy,
    gitRunner: opts.gitRunner,
    costReader: opts.costReader,
    costToday: opts.costReader
      ? ((home: string) => costToday(home, opts.costReader))
      : undefined,
    log: opts.log,
  };
  const ledger: Record<string, number> = {};
  const jobs = (opts.load ?? (() => loadJobs(opts.home)))();
  const loops = jobs.map(async (job) => {
    if (job.trigger) {
      // trigger jobs that poll (on_uncommitted / on_cost_over) are checked
      // once a minute like cron; event-driven ones ride their own listeners
      const pollable = job.trigger.type === "on_uncommitted" || job.trigger.type === "on_cost_over";
      if (!pollable) return;
      const count = await runScheduler({
        intervalMs: 60_000,
        maxRuns: opts.maxRuns,
        runner: () => { void tick(job, ctx); },
        signal: opts.signal,
        log: opts.log ?? (() => {}),
      });
      ledger[job.id] = count;
      return;
    }
    const intervalMs = job.cron !== undefined ? 60_000 : parseInterval(job.interval!);
    const count = await runScheduler({
      intervalMs,
      maxRuns: opts.maxRuns,
      runner: () => { void tick(job, ctx); },
      signal: opts.signal,
      log: opts.log ?? (() => {}),
    });
    ledger[job.id] = count;
  });
  await Promise.all(loops);
  // We are stopping (aborted, or maxRuns reached): give the leases back
  // except the ones with a child still running.
  releaseOwnLeases(opts.home, undefined, inFlight);
  return ledger;
}

