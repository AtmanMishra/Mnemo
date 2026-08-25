#!/usr/bin/env node
/**
 * sea-loop: run `sea "<prompt>"` on a repeating schedule.
 *
 * Usage:
 *   node bin/sea-loop.ts --every 30m --prompt "check CI status and fix failures" [--max-runs 5] [--quiet]
 *
 * Each tick spawns the sea CLI one-shot (`node bin/sea.ts "<prompt>"`) as a
 * child process, so every run inherits the full environment: memory journal
 * env vars, provider keys, and SEA_APPROVAL_MODE. Run start/end is logged to
 * stderr. Stops after --max-runs runs, or on Ctrl+C (SIGINT aborts both the
 * wait and any in-flight child).
 *
 * Interval format: <number><s|m|h>, e.g. 30s, 10m, 2h.
 *
 * Testing: parseInterval() and runScheduler() are exported and take/inject a
 * runner function, so scheduling logic is tested WITHOUT any LLM or spawn.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** Parse "30s" | "10m" | "2h" into milliseconds. Throws on bad input. */
export function parseInterval(spec: string): number {
  const m = /^(\d+)([smh])$/.exec(spec);
  if (!m) {
    throw new Error(`invalid interval "${spec}": expected <number><s|m|h>, e.g. 30s, 10m, 2h`);
  }
  const n = Number(m[1]);
  const mult = m[2] === "s" ? 1_000 : m[2] === "m" ? 60_000 : 3_600_000;
  return n * mult;
}

export interface SchedulerOptions {
  intervalMs: number;
  /** Stop after this many runs. Undefined = run until aborted. */
  maxRuns?: number;
  /** One tick of work. Injected so tests never touch the CLI or LLM. */
  runner: (runIndex: number) => void | Promise<void>;
  /** Aborting stops the loop (and, in main(), any in-flight child). */
  signal?: AbortSignal;
  quiet?: boolean;
  /** Log sink; defaults to console.error unless quiet. */
  log?: (msg: string) => void;
}

function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `runner` immediately, then again every intervalMs, until maxRuns is
 * reached or `signal` aborts. Returns the number of completed runs.
 */
export async function runScheduler(opts: SchedulerOptions): Promise<number> {
  if (!(opts.intervalMs > 0)) throw new Error("intervalMs must be > 0");
  const log = opts.log ?? ((msg: string) => { if (!opts.quiet) console.error(msg); });
  let runs = 0;
  for (;;) {
    if (opts.signal?.aborted) break;
    if (opts.maxRuns !== undefined && runs >= opts.maxRuns) break;
    const started = Date.now();
    log(`[sea-loop] run ${runs + 1}${opts.maxRuns !== undefined ? `/${opts.maxRuns}` : ""} starting`);
    await opts.runner(runs);
    runs++;
    log(`[sea-loop] run ${runs} finished in ${Date.now() - started}ms`);
    if (opts.maxRuns !== undefined && runs >= opts.maxRuns) break;
    await sleepInterruptible(opts.intervalMs, opts.signal);
  }
  return runs;
}

export interface LoopArgs {
  every: string;
  prompt: string;
  maxRuns?: number;
  quiet: boolean;
}

export function parseArgs(argv: string[]): LoopArgs {
  const args: LoopArgs = { quiet: false, every: "", prompt: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--every") args.every = argv[++i] ?? "";
    else if (a === "--prompt") args.prompt = argv[++i] ?? "";
    else if (a === "--max-runs") args.maxRuns = Number(argv[++i]);
    else if (a === "--quiet") args.quiet = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.every) throw new Error("--every is required");
  if (!args.prompt) throw new Error("--prompt is required");
  if (args.maxRuns !== undefined && !(args.maxRuns >= 1)) throw new Error("--max-runs must be >= 1");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const intervalMs = parseInterval(args.every);
  // Same resolution rule as spawn_subagent: SEA_AGENT_BIN overrides the CLI.
  const cli = process.env.SEA_AGENT_BIN ?? path.join(import.meta.dirname ?? ".", "sea.ts");

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  // One-shot CLI run; inherits env (memory journal, provider keys,
  // SEA_APPROVAL_MODE) and stdio, so interactive approval still reaches the user.
  const runner = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [cli, args.prompt], {
        env: { ...process.env },
        stdio: "inherit",
        signal: controller.signal,
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
  };

  console.error(`[sea-loop] every=${args.every}${args.maxRuns !== undefined ? ` max-runs=${args.maxRuns}` : ""} prompt="${args.prompt}"`);
  const runs = await runScheduler({
    intervalMs,
    maxRuns: args.maxRuns,
    runner,
    signal: controller.signal,
    quiet: args.quiet,
    // main()'s own lifecycle messages stay on stderr even with --quiet;
    // --quiet only silences them too:
    log: (msg) => { if (!args.quiet) console.error(msg); },
  });
  console.error(`[sea-loop] done after ${runs} run(s)`);
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
