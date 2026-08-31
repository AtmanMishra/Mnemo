/**
 * AREA 10.1 — the job store (~/.mnemo/schedules.json). Everything runs
 * against a temp HOME; nothing reads the developer's real files.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadJobs, saveJobs, normalizeJob, newJobId, describe, periodMs,
  nextRunOf, isDue, markRun, triggerReady, triggerCooldown,
  schedulesPath, type ScheduleJob,
} from "../src/schedule/store.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sea-sched-store-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const home = path.join(tmp, "home");

function job(o: Partial<ScheduleJob>): ScheduleJob {
  return {
    id: o.id ?? "nightly-0001",
    name: o.name ?? "nightly",
    prompt: o.prompt ?? "check CI and fix failures",
    enabled: o.enabled ?? true,
    ...o,
  };
}

test("missing store is an empty list", () => {
  assert.deepEqual(loadJobs(home), []);
});

test("save + load round-trips every field, omitting absent ones", () => {
  const jobs: ScheduleJob[] = [
    job({ id: "a", cron: "0 9 * * *", model: "opencode-go/deepseek-v4-flash", scope: "/repo" }),
    job({ id: "b", interval: "30m", enabled: false }),
    job({
      id: "c",
      trigger: { type: "on_uncommitted", params: { cooldownMs: 300_000 } },
      lastRun: 1234,
      nextRun: 5678,
      lastResult: { ok: true, at: 1234, durationMs: 900, detail: "spawn failed" },
    }),
  ];
  saveJobs(home, jobs);
  const reloaded = loadJobs(home);
  assert.equal(reloaded.length, 3);
  assert.equal(reloaded[0]!.cron, "0 9 * * *");
  assert.equal(reloaded[0]!.model, "opencode-go/deepseek-v4-flash");
  assert.equal(reloaded[1]!.interval, "30m");
  assert.equal(reloaded[1]!.enabled, false);
  assert.equal(reloaded[2]!.trigger!.type, "on_uncommitted");
  assert.equal(reloaded[2]!.lastResult!.ok, true);
  assert.equal(reloaded[2]!.lastResult!.detail, "spawn failed");
  assert.equal(reloaded[2]!.lastResult!.durationMs, 900);
});

test("a job must be driven by exactly one of cron/interval/trigger", () => {
  assert.throws(() => normalizeJob({ id: "x", name: "x", prompt: "p" }), /exactly one/);
  assert.throws(() => normalizeJob({ id: "x", name: "x", prompt: "p", cron: "* * * * *", interval: "30m" }), /exactly one/);
  const ok = normalizeJob({ id: "x", name: "x", prompt: "p", cron: "* * * * *" });
  assert.equal(ok.cron, "* * * * *");
  assert.throws(() => normalizeJob({ id: "x", name: "x", prompt: "p", cron: "9 * *" }), /bad cron/);
  assert.throws(() => normalizeJob({ id: "x", name: "x", prompt: "p", interval: "90z" }), /bad interval/);
  assert.throws(() => normalizeJob({ id: "x", name: "x", prompt: "p", trigger: { type: "on_launch" } }), /unknown type/);
  assert.throws(() => normalizeJob({ id: "", name: "x", prompt: "p", cron: "* * * * *" }), /non-empty/);
});

test("newJobId slugs the name and stays filename-safe", () => {
  // 0.5 * 0xffff = 32767 = 0x7fff; 0.1 * 0xffff = 6553 = 0x1999
  const id = newJobId("Nightly CI!!", () => 0.5);
  assert.match(id, /^nightly-ci-[0-9a-f]{4}$/);
  assert.equal(newJobId("!@#$", () => 0.1), "job-1999");
  assert.equal(newJobId("Nightly CI!!", () => 0.5), "nightly-ci-7fff");
});

test("describe names the schedule and trigger knobs", () => {
  assert.equal(describe(job({ cron: "* * * * *" })), "every minute");
  assert.equal(describe(job({ interval: "30m" })), "every 30m");
  const t = describe(job({ trigger: { type: "on_cost_over", params: { budget: 3.5, cooldownMs: 120_000 } } }));
  assert.match(t, /on_cost_over/);
  assert.match(t, /budget \$3.5/);
});

test("periodMs and nextRunOf: cron is minute-grained, interval honours the spec", () => {
  assert.equal(periodMs(job({ cron: "* * * * *" })), 60_000);
  assert.equal(periodMs(job({ interval: "2h" })), 7_200_000);
  assert.equal(nextRunOf(job({ interval: "30m" }), 1_000_000), 1_000_000 + 1_800_000);
  const cron = nextRunOf(job({ cron: "30 9 * * *" }), new Date(2026, 5, 15, 9, 0, 0).getTime())!;
  assert.equal(cron, new Date(2026, 5, 15, 9, 30, 0).getTime());
});

test("isDue honours enabled, nextRun, and never for triggers", () => {
  const neverFired = job({ cron: "0 9 * * *", nextRun: null });
  assert.equal(isDue(neverFired, 1_700_000_000_000), true);
  const future = job({ cron: "0 9 * * *", nextRun: 2_000_000_000_000 });
  assert.equal(isDue(future, 1_700_000_000_000), false);
  assert.equal(isDue(future, 3_000_000_000_000), true);
  const paused = job({ cron: "0 9 * * *", enabled: false, nextRun: 1_000 });
  assert.equal(isDue(paused, 5_000), false);
  const trig = job({ trigger: { type: "on_failure" }, nextRun: 0 });
  assert.equal(isDue(trig, 5_000), false, "triggers fire on events, not the clock");
});

test("markRun advances nextRun from the fire moment", () => {
  const j = job({ interval: "30m" });
  markRun(j, 1_000_000);
  assert.equal(j.lastRun, 1_000_000);
  assert.equal(j.nextRun, 1_000_000 + 1_800_000);
  assert.equal(j.lastResult, null);
  markRun(j, 2_800_000, { ok: true, at: 2_800_000, durationMs: 42 });
  assert.equal(j.lastResult!.ok, true);
});

test("trigger cooldown gates re-fires", () => {
  const j = job({ trigger: { type: "on_uncommitted" } });
  assert.equal(triggerCooldown(j), 60_000);
  assert.equal(triggerReady(j, 1_000), true, "never fired = ready");
  j.lastRun = 1_000;
  assert.equal(triggerReady(j, 1_000 + 30_000), false);
  assert.equal(triggerReady(j, 1_000 + 60_000), true);
  const t2 = job({ trigger: { type: "on_cost_over", params: { cooldownMs: 5_000 } } });
  assert.equal(triggerCooldown(t2), 5_000);
});

test("schedulesPath points at ~/.mnemo/schedules.json", () => {
  assert.equal(schedulesPath("/home/x"), path.join("/home/x", ".mnemo", "schedules.json"));
});