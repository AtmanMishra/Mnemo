/**
 * AREA 10.2/10.4 — `mnemo schedule ...` CLI commands against a temp HOME.
 * No provider, no LLM: only file store + injected runner.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSchedule, listBody } from "../src/schedule/cli.ts";
import { loadJobs } from "../src/schedule/store.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sea-sched-cli-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });

let homeNo = 0;
/** One store per test — tests must never share a schedules.json. */
function freshHome(): string {
  return fs.mkdtempSync(path.join(tmp, `home-${homeNo++}-`));
}

function cli(argv: string[], home: string, rng: () => number = () => 0.5) {
  const log: string[] = [];
  const err: string[] = [];
  return {
    log,
    err,
    run: (a: string[] = argv) => runSchedule(a, {
      home,
      cwd: repo,
      env: {},
      argv: a,
      log: (s) => log.push(s),
      err: (s) => err.push(s),
      rng,
      runChild: async (job) => ({ ok: true, at: 123, durationMs: 7 }),
    }),
  };
}

test("empty store lists a hint and exits 0", async () => {
  const c = cli(["list"], freshHome());
  assert.equal(await c.run(), 0);
  assert.match(c.log[0]!, /no schedules yet/);
});

test("add creates a cron job: prompt, id, enabled, described", async () => {
  const home = freshHome();
  const c = cli(["add", "--cron", "0 9 * * 1", "--prompt", "check CI status and fix failures", "--name", "nightly"], home);
  assert.equal(await c.run(), 0);
  assert.match(c.log[0]!, /added nightly-7fff \(nightly\)/);
  const jobs = loadJobs(home);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.cron, "0 9 * * 1");
  assert.equal(jobs[0]!.prompt, "check CI status and fix failures");
  assert.equal(jobs[0]!.enabled, true);
  assert.ok(jobs[0]!.nextRun === null || jobs[0]!.nextRun === undefined);
});

test("add rejects junk and missing pieces", async () => {
  const home = freshHome();
  const c = cli(["add", "--interval", "30m"], home);
  assert.equal(await c.run(), 2);
  assert.match(c.err[0]!, /--prompt/);
  const c2 = cli(["add", "--cron", "bad", "--prompt", "x"], home);
  assert.equal(await c2.run(), 2);
  assert.match(c2.err[0]!, /bad cron/);
  const c3 = cli(["add", "--cron", "* * * * *", "--interval", "30m", "--prompt", "x"], home);
  assert.equal(await c3.run(), 2);
  assert.match(c3.err[0]!, /not both/);
  assert.equal(loadJobs(home).length, 0, "no failed add touches the store");
});

test("pause/resume flip enabled and persist", async () => {
  const home = freshHome();
  await cli(["add", "--interval", "10m", "--prompt", "poll"], home).run();
  const id = loadJobs(home)[0]!.id;
  const p = cli(["pause", id], home);
  assert.equal(await p.run(), 0);
  assert.equal(loadJobs(home)[0]!.enabled, false);
  const r = cli(["resume", id], home);
  assert.equal(await r.run(), 0);
  assert.equal(loadJobs(home)[0]!.enabled, true);
  const missing = cli(["pause", "nope"], home);
  assert.equal(await missing.run(), 2);
  assert.match(missing.err[0]!, /no job/);
});

test("rm removes by id", async () => {
  const home = freshHome();
  await cli(["add", "--cron", "* * * * *", "--prompt", "x"], home).run();
  const id = loadJobs(home)[0]!.id;
  assert.equal(await cli(["rm", id], home).run(), 0);
  assert.equal(loadJobs(home).length, 0);
});

test("fire runs the injected child and records a result", async () => {
  const home = freshHome();
  await cli(["add", "--interval", "1h", "--prompt", "do it"], home).run();
  const id = loadJobs(home)[0]!.id;
  const c = cli(["fire", id], home);
  assert.equal(await c.run(), 0);
  assert.match(c.log[0]!, /fired/);
  assert.equal(loadJobs(home)[0]!.lastResult!.ok, true);
  assert.equal(loadJobs(home)[0]!.lastResult!.durationMs, 7);
});

test("fire on a paused job refuses", async () => {
  const home = freshHome();
  await cli(["add", "--interval", "1h", "--prompt", "do it"], home).run();
  const id = loadJobs(home)[0]!.id;
  await cli(["pause", id], home).run();
  const c = cli(["fire", id], home);
  assert.equal(await c.run(), 1);
  assert.match(c.err[0]!, /paused/);
});

test("trigger add/list/rm round-trip through the same store", async () => {
  const home = freshHome();
  const c = cli(["trigger", "add", "--type", "on_uncommitted", "--prompt", "commit the work", "--name", "autocommit"], home);
  assert.equal(await c.run(), 0);
  assert.match(c.log[0]!, /added trigger \S+ \(autocommit\) — on_uncommitted/);
  const c2 = cli(["trigger", "add", "--type", "on_cost_over", "--prompt", "summarise spend", "--budget", "2.5", "--cooldown-ms", "300000"], home);
  assert.equal(await c2.run(), 0);
  const jobs = loadJobs(home);
  assert.equal(jobs.length, 2);
  const cost = jobs.find((j) => j.trigger?.type === "on_cost_over")!;
  assert.equal(cost.trigger!.params!.budget, 2.5);
  assert.equal(cost.trigger!.params!.cooldownMs, 300_000);
  const l = cli(["trigger", "list"], home);
  assert.equal(await l.run(), 0);
  assert.ok(l.log.some((s) => s.includes("on_cost_over")), "list shows the trigger");
  assert.equal(await cli(["trigger", "add", "--type", "on_launch", "--prompt", "x"], home).run(), 2);
  // `trigger fire <id>` == `fire <id>` for the same job
  const id = loadJobs(home)[0]!.id;
  const f = cli(["trigger", "fire", id], home);
  assert.equal(await f.run(), 0);
});

test("daemon --once walks the store without spawning children forever", async () => {
  const home = freshHome();
  await cli(["add", "--interval", "30s", "--prompt", "tick", "--id", "tick-0001"], home).run();
  const log: string[] = [];
  const code = await runSchedule(["daemon", "--once"], {
    home, cwd: repo, env: {}, argv: ["daemon", "--once"],
    log: (s) => log.push(s), err: (s) => log.push(s),
    runChild: async () => ({ ok: true, at: 1, durationMs: 1 }),
  });
  assert.equal(code, 0);
  const seen = loadJobs(home)[0]!;
  assert.equal(typeof seen.lastRun, "number", "--once ticks the store");
  assert.ok(seen.lastResult!.ok);
});

test("listBody renders pause marker and result", () => {
  const jobs = loadJobs(freshHome());
  assert.deepEqual(listBody(jobs), []);
});