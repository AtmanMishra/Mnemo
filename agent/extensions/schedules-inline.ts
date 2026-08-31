/**
 * AREA 10.2/10.4 — the in-session schedules extension.
 *
 * While a pi session runs, IT hosts a lightweight ticker (only when a
 * schedules file exists — otherwise zero overhead), so scheduled jobs fire
 * even when no `mnemo schedule daemon` is running. Firing is gated by the
 * SAME lockfile lease the daemon uses, so the two hosts can never both run
 * the same job in the same window. Every tick is a one-shot child that
 * inherits the full environment (shared memory journal included), so each
 * run is a TaskEpisode exactly like interactive work (10.3).
 *
 * Also wires the trigger listeners that only a session can host:
 *   on_failure  <- turn_end with stopReason "error" (same signal the memory
 *                  layer steers on)
 * and the session commands: /schedule, /trigger, /now (fire any job now).
 * on_uncommitted / on_cost_over are evaluated by the per-minute tick both
 * here and in the daemon. on_push needs a webhook listener — deferred (10.4).
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { fireNow, runDaemon, type FireContext } from "../src/schedule/daemon.ts";
import { runSchedule } from "../src/schedule/cli.ts";
import { loadJobs, type ScheduleJob } from "../src/schedule/store.ts";

/** Prod home: the same ~/.mnemo the tracer and auth store use. */
export function schedulesHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? "";
}

export interface SessionTicker {
  stop: () => void;
  /** The daemon loops (for tests: how many per-job loops started). */
  started: number;
}

/**
 * Start the per-job ticker loops. Deterministic-testable: it accepts the
 * whole FireContext, so tests drive it with injected runner/clock; prod calls
 * it with defaults (real spawns, real clock).
 */
export function startSessionTicker(ctx: FireContext & { home: string; cwd: string }): SessionTicker {
  const controller = new AbortController();
  const jobs = (ctx.load ?? (() => loadJobs(ctx.home)))();
  const started = jobs.filter((j) => j.trigger ? j.trigger.type === "on_uncommitted" || j.trigger.type === "on_cost_over" : true).length;
  // Fire the full pass immediately, then let runDaemon take over the loops.
  void runDaemon({
    home: ctx.home,
    cwd: ctx.cwd,
    env: ctx.env,
    now: ctx.now,
    load: ctx.load,
    save: ctx.save,
    runChild: ctx.runChild,
    gitRunner: ctx.gitRunner,
    costReader: ctx.costReader,
    signal: controller.signal,
    log: ctx.log,
  });
  return { stop: () => controller.abort(), started };
}

/** on_failure: a failed turn fires every enabled on_failure job (cooldown
 * gated, lease gated). Best-effort — a dead sidecar never breaks the loop. */
export async function fireOnFailure(ctx: FireContext, cwd: string): Promise<string[]> {
  const jobs = (ctx.load ?? (() => loadJobs(ctx.home)))();
  const targets = jobs.filter((j) => j.trigger?.type === "on_failure");
  const report: string[] = [];
  for (const job of targets) {
    const outcome = await fireNow(job, ctx);
    if (outcome === "fired") report.push(`triggered on_failure: ${job.name}`);
  }
  return report;
}

/** Turn-end wire: only failures steer (mirrors the memory layer's rule). */
function attachFailureListener(pi: ExtensionAPI, ctx: FireContext): void {
  pi.on("turn_end", async (event: any) => {
    try {
      const msg = event?.message ?? {};
      if (msg.stopReason !== "error") return;
      await fireOnFailure(ctx, process.cwd());
    } catch { /* a failure-trigger must never break the loop */ }
  });
}

/** One shared runner for /schedule, /trigger and /now commands. */
async function runSessionCommand(
  argv: string[],
  ctx: FireContext,
  ui: { notify: (m: string, t?: string) => void },
): Promise<string> {
  const lines: string[] = [];
  const code = await runSchedule(argv, {
    home: ctx.home,
    cwd: ctx.cwd,
    env: process.env,
    argv,
    log: (s) => lines.push(s),
    err: (s) => lines.push(s),
  });
  const report = lines.join("\n") || `schedule: ${code === 0 ? "ok" : "error"}`;
  ui.notify?.(report, "info");
  return report;
}

export interface ScheduleExtensionState {
  ticker: SessionTicker | null;
}

export function schedulesInlineFactory(pi: ExtensionAPI): void {
  const home = schedulesHome();
  const cwd = process.cwd();
  const state: ScheduleExtensionState = { ticker: null };
  const ctx: FireContext = { home, cwd, env: process.env, log: (m) => console.error(m) };

  pi.on("session_start", async () => {
    // only when a schedule file exists — otherwise the session carries zero
    // scheduling overhead
    if (state.ticker) return;
    let exists = false;
    try {
      exists = loadJobs(home).length > 0;
    } catch { exists = false; }
    if (!exists) return;
    state.ticker = startSessionTicker({ ...ctx, home, cwd });
  });

  pi.on("session_shutdown", () => {
    state.ticker?.stop();
    state.ticker = null;
  });

  attachFailureListener(pi, ctx);

  const cmdCtx = () => ({
    home,
    cwd,
    env: process.env,
    runChild: ctx.runChild,
    log: (m: string) => console.error(m),
  });

  pi.registerCommand("schedule", {
    description: "Schedules: list|add|rm|pause|resume|fire|trigger (jobs stored in ~/.mnemo/schedules.json)",
    handler: async (args: string, c: any) => {
      await runSessionCommand(tok(args), { ...ctx, log: cmdCtx().log }, c?.ui ?? { notify: () => {} });
    },
  });

  pi.registerCommand("trigger", {
    description: "Triggers: list|add|rm|pause|resume|fire (on_failure, on_uncommitted, on_cost_over, on_push)",
    handler: async (args: string, c: any) => {
      await runSessionCommand(["trigger", ...tok(args)], { ...ctx, log: cmdCtx().log }, c?.ui ?? { notify: () => {} });
    },
  });

  pi.registerCommand("now", {
    description: "Fire any scheduled job immediately (the universal test button): /now <job-id>",
    handler: async (args: string, c: any) => {
      const id = args.trim().split(/\s+/)[0] ?? "";
      if (!id) {
        c?.ui?.notify?.("/now needs a job id — /schedule list", "warning");
        return;
      }
      const jobs = loadJobs(home);
      const job = jobs.find((j) => j.id === id);
      if (!job) {
        c?.ui?.notify?.(`no job "${id}" — /schedule list`, "warning");
        return;
      }
      const outcome = await fireNow(job, { ...ctx, runChild: cmdCtx().runChild });
      c?.ui?.notify?.(
        outcome === "fired" ? `ran ${job.name} now` :
        outcome === "disabled" ? `${job.name} is paused — resume it first` :
        outcome === "lease-held" ? `${job.name}: another host is running it` :
        `${job.name}: ${outcome}`,
        "info",
      );
    },
  });
}

/** Quote-aware tokenizer for command argv (pi passes args as one string). */
export function tok(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === " " || ch === "\n") {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export const schedulesExt: InlineExtension = {
  name: "sea-schedules",
  factory: schedulesInlineFactory as any,
};

export default schedulesExt;