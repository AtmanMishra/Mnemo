/**
 * AREA 10.2/10.3 — daemon tick semantics with real store + real lockfiles
 * but injected clock, injected runner, temp HOME, and a probe CLI child.
 * No LLM anywhere.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tick, fireNow, tickAll, childEnv, defaultChild, runDaemon, type FireContext } from "../src/schedule/daemon.ts";
import { loadJobs, saveJobs, type ScheduleJob } from "../src/schedule/store.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sea-sched-daemon-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const home = path.join(tmp, "home");
let nowMs = 1_700_000_000_000;
const now = () => nowMs;

function job(o: Partial<ScheduleJob>): ScheduleJob {
  return {
    id: o.id ?? "job-0001",
    name: o.name ?? "job",
    prompt: o.prompt ?? "run the thing",
    enabled: o.enabled ?? true,
    ...o,
  };
}

/** A FireContext with a recorded runner over the real temp store/lease. */
function ctx(overrides: Partial<FireContext> = {}, fireLog: JobResult[] = []): FireContext {
  return {
    home,
    cwd: path.join(tmp, "repo"),
    now,
    runChild: async (j: ScheduleJob) => {
      const r = { ok: true, at: now(), durationMs: 10 };
      fireLog.push(r);
      return r;
    },
    log: () => {},
    ...overrides,
  };
}

type JobResult = { ok: boolean; at: number; durationMs?: number; detail?: string };

function seed(jobs: ScheduleJob[]): void {
  saveJobs(home, jobs);
}

function reload(): ScheduleJob[] {
  return loadJobs(home);
}

test("a due cron job fires once, advances bookkeeping, records the result", async () => {
  seed([job({ id: "nightly", name: "nightly", cron: "0 9 * * *", nextRun: 0 })]);
  const fired: JobResult[] = [];
  const outcome = await tick(reload()[0]!, ctx({}, fired));
  assert.equal(outcome, "fired");
  assert.equal(fired.length, 1);
  const stored = reload()[0]!;
  assert.equal(stored.lastRun, nowMs);
  assert.ok(stored.nextRun! > nowMs, "nextRun moved to the next 09:00");
  assert.equal(stored.lastResult!.ok, true);
  // an immediate second tick is NOT due again
  assert.equal(await tick(reload()[0]!, ctx({}, fired)), "not-due");
  assert.equal(fired.length, 1);
});

test("a disabled job never fires", async () => {
  seed([job({ id: "off", name: "off", interval: "30s", enabled: false, nextRun: 0 })]);
  const fired: JobResult[] = [];
  assert.equal(await tick(reload()[0]!, ctx({}, fired)), "disabled");
  assert.equal(fired.length, 0);
});

test("double-fire prevention: a lease held by another host skips the window", async () => {
  seed([job({ id: "both", name: "both", interval: "1m", nextRun: 0 })]);
  const holderFired: JobResult[] = [];
  const loserFired: JobResult[] = [];
  // host A (pid 8888, alive) fires first
  const a = ctx({}, holderFired);
  a.acquire = (jobId: string) => acquireAs(jobId, 8888, 60_000);
  a.release = (jobId: string) => releaseAs(jobId, 8888);
  assert.equal(await tick(reload()[0]!, a), "fired");
  assert.equal(holderFired.length, 1);
  // host B (different pid) sees the live lease and takes the hint
  const b = ctx({}, loserFired);
  b.acquire = (jobId: string) => acquireAs(jobId, 9999, 60_000);
  b.release = (jobId: string) => releaseAs(jobId, 9999);
  seed([job({ id: "both", name: "both", interval: "1m", nextRun: 0 })]);
  assert.equal(await tick(reload()[0]!, b), "lease-held");
  assert.equal(loserFired.length, 0);
});

import { acquireLease, releaseLease } from "../src/schedule/lease.ts";
function acquireAs(jobId: string, pid: number, holdMs: number): boolean {
  return acquireLease({ home, jobId, holdMs, now, pid, isAlive: () => true });
}
function releaseAs(jobId: string, pid: number): boolean {
  return releaseLease({ home, jobId, pid });
}

test("/now fires an interval job immediately even when nextRun is far", async () => {
  seed([job({ id: "manual", name: "manual", interval: "2h", nextRun: nowMs + 3_600_000 })]);
  const fired: JobResult[] = [];
  const outcome = await fireNow(reload()[0]!, ctx({}, fired));
  assert.equal(outcome, "fired");
  assert.equal(fired.length, 1);
  const stored = reload()[0]!;
  assert.equal(stored.lastRun, nowMs);
});

test("/now respects trigger cooldown but bypasses the clock for events", async () => {
  seed([job({ id: "fail", name: "fail", trigger: { type: "on_failure" }, lastRun: nowMs - 5_000 })]);
  const fired: JobResult[] = [];
  // cooldown (default 60s) not elapsed -> skipped from a tick
  assert.equal(await tick(reload()[0]!, ctx({}, fired)), "skipped");
  assert.equal(fired.length, 0);
  // but /now on a plain job fires regardless (no trigger)
  seed([job({ id: "plain", name: "plain", interval: "1h", nextRun: nowMs + 600_000 })]);
  assert.equal(await fireNow(reload()[0]!, ctx({}, fired)), "fired");
  assert.equal(fired.length, 1);
});

test("on_uncommitted fires when the scope is dirty, and only after cooldown", async () => {
  seed([job({ id: "dirty", name: "dirty", trigger: { type: "on_uncommitted" } })]);
  const fired: JobResult[] = [];
  const dirty = ctx({}, fired);
  dirty.gitRunner = async () => " M main.go\n";
  assert.equal(await tick(reload()[0]!, dirty), "fired");
  assert.equal(fired.length, 1);
  // still dirty, still within cooldown -> skipped
  assert.equal(await tick(reload()[0]!, dirty), "skipped");
  // clean repo -> not-due even after cooldown elapses
  nowMs += 120_000;
  const clean = ctx({}, fired);
  clean.gitRunner = async () => "";
  assert.equal(await tick(reload()[0]!, clean), "not-due");
  assert.equal(fired.length, 1);
});

test("on_cost_over fires only when real trace cost crosses the budget", async () => {
  seed([job({ id: "spend", name: "spend", trigger: { type: "on_cost_over", params: { budget: 2.0 } } })]);
  const fired: JobResult[] = [];
  const cheap = ctx({}, fired);
  cheap.costToday = async () => 1.2;
  assert.equal(await tick(reload()[0]!, cheap), "not-due");
  const spendy = ctx({}, fired);
  spendy.costToday = async () => 2.3;
  assert.equal(await tick(reload()[0]!, spendy), "fired");
  assert.equal(fired.length, 1);
});

test("a job with no budget configured can never fire on cost", async () => {
  seed([job({ id: "nobudget", name: "nobudget", trigger: { type: "on_cost_over" } })]);
  const fired: JobResult[] = [];
  const c = ctx({}, fired);
  c.costToday = async () => 999;
  assert.equal(await tick(reload()[0]!, c), "not-due");
});

test("childEnv carries the shared journal and tags the run", () => {
  const base: NodeJS.ProcessEnv = {
    HOME: "/home/x",
    MNEMO_MEMORY_JOURNAL: "/shared/journal.jsonl",
    MNEMO_MODEL: "fallback-model",
  };
  const env = childEnv(job({ id: "nightly", name: "nightly", model: "opencode-go/deepseek-v4-flash" }), base);
  assert.equal(env.MNEMO_MEMORY_JOURNAL, "/shared/journal.jsonl", "journal must be inherited");
  assert.equal(env.MNEMO_SCHEDULE_JOB, "nightly");
  assert.equal(env.MNEMO_SCHEDULE_NAME, "nightly");
  assert.equal(env.MNEMO_MODEL, "opencode-go/deepseek-v4-flash", "model override wins");
  const noOverride = childEnv(job({ id: "x" }), base);
  assert.equal(noOverride.MNEMO_MODEL, "fallback-model", "no override = env untouched");
});

test("a scheduled child really inherits the full environment (probe CLI)", async () => {
  // A REAL one-shot child: the same spawn path the daemon uses, pointed at a
  // probe script instead of the LLM. Proves MNEMO_MEMORY_JOURNAL and the
  // schedule tags reach the spawned process, and scope becomes its cwd.
  const probeDir = path.join(tmp, "probe");
  fs.mkdirSync(probeDir, { recursive: true });
  const probe = path.join(probeDir, "probe.mjs");
  fs.writeFileSync(probe, `
    import * as fs from "node:fs";
    const out = { journal: process.env.MNEMO_MEMORY_JOURNAL, job: process.env.MNEMO_SCHEDULE_JOB, name: process.env.MNEMO_SCHEDULE_NAME, model: process.env.MNEMO_MODEL, cwd: process.cwd() };
    fs.writeFileSync(${JSON.stringify(path.join(probeDir, "seen.json"))}, JSON.stringify(out));
    process.exit(0);
  `);
  const scope = path.join(tmp, "scope");
  fs.mkdirSync(scope, { recursive: true });
  const result = await defaultChild(
    job({ id: "probejob", name: "probejob", scope, model: "opencode-go/deepseek-v4-flash" }),
    { ...process.env, MNEMO_MEMORY_JOURNAL: "/tmp/shared-journal.jsonl", MNEMO_SCHEDULE_JOB: "should-be-overridden" },
    process.cwd(),
    probe,
  );
  assert.equal(result.ok, true);
  const seen = JSON.parse(fs.readFileSync(path.join(probeDir, "seen.json"), "utf8"));
  assert.equal(seen.journal, "/tmp/shared-journal.jsonl");
  assert.equal(seen.job, "probejob", "schedule tag overrides a stale env value");
  assert.equal(seen.name, "probejob");
  assert.equal(seen.model, "opencode-go/deepseek-v4-flash");
  assert.equal(seen.cwd, fs.realpathSync(scope), "job scope becomes the child's working directory");
});

test("tickAll does a single pass over every job", async () => {
  seed([
    job({ id: "a", cron: "0 9 * * *", nextRun: 0 }),
    job({ id: "b", cron: "0 9 * * *", nextRun: nowMs + 3600_000 }),
  ]);
  const fired: JobResult[] = [];
  const outcomes = await tickAll(ctx({}, fired));
  assert.deepEqual(outcomes.sort(), ["fired", "not-due"].sort());
  assert.equal(fired.length, 1);
});

test("runDaemon: one immediate tick per job with maxRuns=1 (no sleeping)", async () => {
  seed([
    job({ id: "d1", interval: "30s", nextRun: 0 }),
    job({ id: "d2", interval: "30s", nextRun: nowMs + 5000 }),
  ]);
  const fired: JobResult[] = [];
  const ledger = await runDaemon({
    home,
    cwd: path.join(tmp, "repo"),
    maxRuns: 1,
    now,
    runChild: async (j) => { const r = { ok: true, at: now(), durationMs: 3 }; fired.push(r); return r; },
    log: () => {},
  });
  assert.equal(ledger.d1, 1);
  assert.equal(ledger.d2, 1);
  assert.equal(fired.length, 1, "only the due job's child ran");
});