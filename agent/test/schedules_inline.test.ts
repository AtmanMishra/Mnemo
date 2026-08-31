/**
 * AREA 10.2/10.4 — the in-session schedules extension: ticker start/stop,
 * on_failure from turn_end, and the /schedule|/trigger|/now command wiring.
 * Driven with a fake pi and fully injected FireContexts — no LLM, no pi.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  tok, fireOnFailure, startSessionTicker, schedulesInlineFactory,
} from "../extensions/schedules-inline.ts";
import { loadJobs, saveJobs, type ScheduleJob } from "../src/schedule/store.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sea-sched-ext-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const home = path.join(tmp, "home");

function job(o: Partial<ScheduleJob>): ScheduleJob {
  return { id: "j-1", name: "j", prompt: "p", enabled: true, ...o };
}

type JobResult = { ok: boolean; at: number; durationMs?: number; detail?: string };

test("tok splits on whitespace but keeps quoted prompts whole", () => {
  assert.deepEqual(tok("add --name \"nightly checks\" --prompt \"fix it now\""), [
    "add", "--name", "nightly checks", "--prompt", "fix it now",
  ]);
  assert.deepEqual(tok("now nightly-0001"), ["now", "nightly-0001"]);
  assert.deepEqual(tok(""), []);
  assert.deepEqual(tok("  a   b  "), ["a", "b"]);
});

test("fireOnFailure fires every enabled on_failure job and reports", async () => {
  saveJobs(home, [
    job({ id: "f1", name: "self-heal", trigger: { type: "on_failure" } }),
    job({ id: "f2", name: "other", trigger: { type: "on_failure" }, enabled: false }),
    job({ id: "c1", name: "cron", cron: "* * * * *" }),
  ]);
  const fired: string[] = [];
  const ctx = {
    home,
    cwd: tmp,
    now: () => 100,
    runChild: async (j: ScheduleJob) => { fired.push(j.id); return { ok: true, at: 100, durationMs: 1 } as JobResult; },
    log: () => {},
  };
  const report = await fireOnFailure(ctx, tmp);
  assert.deepEqual(fired, ["f1"]);
  assert.equal(report.length, 1);
  assert.match(report[0]!, /self-heal/);
  assert.equal(loadJobs(home).find((j) => j.id === "f1")!.lastRun, 100, "lastRun advanced");
});

test("on_failure respects trigger cooldown", async () => {
  saveJobs(home, [job({ id: "f1", name: "f1", trigger: { type: "on_failure" }, lastRun: 40 })]);
  const fired: string[] = [];
  const ctx = {
    home, cwd: tmp, now: () => 60, // 20ms after lastRun, cooldown is 60s
    runChild: async (j: ScheduleJob) => { fired.push(j.id); return { ok: true, at: 60, durationMs: 1 } as JobResult; },
    log: () => {},
  };
  const report = await fireOnFailure(ctx, tmp);
  assert.deepEqual(fired, [], "cooldown not elapsed -> no re-fire");
  assert.equal(report.length, 0);
});

test("startSessionTicker starts per-job loops and stops cleanly", async () => {
  saveJobs(home, [
    job({ id: "c1", name: "c1", cron: "* * * * *", nextRun: 0 }),
    job({ id: "i1", name: "i1", interval: "30s", nextRun: 0 }),
    job({ id: "t1", name: "t1", trigger: { type: "on_uncommitted" } }),
    job({ id: "t2", name: "t2", trigger: { type: "on_failure" } }), // event-driven: no loop
  ]);
  let fired = 0;
  const ticker = startSessionTicker({
    home, cwd: tmp,
    now: () => 100,
    runChild: async () => { fired++; return { ok: true, at: 100, durationMs: 1 } as JobResult; },
    gitRunner: async () => " M file\n", // on_uncommitted fires on the first pass
    log: () => {},
  });
  // loops: c1 (cron), i1 (interval), t1 (pollable trigger) = 3; t2 rides events
  assert.equal(ticker.started, 3);
  // allow the immediate first pass to run, then stop
  await new Promise((r) => setTimeout(r, 30));
  ticker.stop();
  assert.ok(fired >= 2, `first pass fired due + dirty-trigger jobs: ${fired}`);
});

/** Fake pi exposing what the factory touches. */
function fakePi() {
  const handlers: Record<string, Function> = {};
  const commands: Record<string, { description: string; handler: Function }> = {};
  return {
    on(name: string, h: Function) { handlers[name] = h; },
    registerCommand(name: string, o: { description: string; handler: Function }) {
      commands[name] = { description: o.description, handler: o.handler ?? (() => {}) };
    },
    handlers,
    commands,
  };
}

test("factory binds lifecycle + failure + the three commands", () => {
  const pi = fakePi() as any;
  schedulesInlineFactory(pi);
  assert.equal(typeof pi.handlers["session_start"], "function");
  assert.equal(typeof pi.handlers["session_shutdown"], "function");
  assert.equal(typeof pi.handlers["turn_end"], "function");
  for (const cmd of ["schedule", "trigger", "now"]) {
    assert.ok(pi.commands[cmd], `expected /${cmd} registered`);
  }
});

test("turn_end does not fire on_failure on a clean turn", async () => {
  // the factory reads env at construction; point HOME at the temp store
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    saveJobs(home, [job({ id: "f", name: "heal", trigger: { type: "on_failure" } })]);
    const pi = fakePi() as any;
    schedulesInlineFactory(pi);
    const turnEnd = pi.handlers["turn_end"] as (e: any) => Promise<void>;
    // a clean turn touches nothing (no spawn, no bookkeeping)
    await turnEnd({ message: { stopReason: "end_turn" } });
    assert.equal(loadJobs(home).find((j) => j.id === "f")!.lastRun, undefined);
  } finally {
    process.env.HOME = prevHome;
  }
  // (the failed-turn path is covered deterministically by fireOnFailure tests
  //  above with an injected runner; here it would spawn the real child.)
});