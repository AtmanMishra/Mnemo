import { test } from "node:test";
import assert from "node:assert";
import { parseInterval, parseArgs, runScheduler } from "../bin/sea-loop.ts";

// ---------- parseInterval matrix ----------

test("parseInterval accepts seconds/minutes/hours", () => {
  assert.equal(parseInterval("30s"), 30_000);
  assert.equal(parseInterval("1s"), 1_000);
  assert.equal(parseInterval("10m"), 600_000);
  assert.equal(parseInterval("2h"), 7_200_000);
});

test("parseInterval throws on bad inputs", () => {
  for (const bad of ["30", "m", "-5s", "1.5h", "30S", "h3", "", "every 30m", "30ms"]) {
    assert.throws(() => parseInterval(bad), `expected throw for ${JSON.stringify(bad)}`);
  }
});

// ---------- parseArgs ----------

test("parseArgs reads flags and validates", () => {
  const a = parseArgs(["--every", "30m", "--max-runs", "5", "--prompt", "check CI", "--quiet"]);
  assert.equal(a.every, "30m");
  assert.equal(a.maxRuns, 5);
  assert.equal(a.prompt, "check CI");
  assert.equal(a.quiet, true);

  assert.throws(() => parseArgs(["--every", "30m"])); // missing prompt
  assert.throws(() => parseArgs(["--prompt", "x"])); // missing every
  assert.throws(() => parseArgs(["--bogus"]));
  assert.throws(() => parseArgs(["--every", "30m", "--prompt", "x", "--max-runs", "0"]));
});

// ---------- scheduler (fake runner, NO LLM) ----------

test("scheduler fires maxRuns times with tiny intervals using a fake runner", async () => {
  const stamps: number[] = [];
  const runs = await runScheduler({
    intervalMs: 100,
    maxRuns: 5,
    runner: async () => { stamps.push(Date.now()); },
    log: () => {}, // silence in tests
  });
  assert.equal(runs, 5);
  assert.equal(stamps.length, 5);
  // First tick immediate; subsequent ticks spaced >= ~interval.
  assert.ok(stamps[1]! - stamps[0]! >= 90, `gap too small: ${stamps[1]! - stamps[0]!}`);
  assert.ok(stamps[4]! - stamps[3]! >= 90);
  // Total elapsed roughly 4 intervals.
  assert.ok(stamps[4]! - stamps[0]! >= 380);
});

test("scheduler stops early on abort signal", async () => {
  const controller = new AbortController();
  let runs = 0;
  const count = await runScheduler({
    intervalMs: 100,
    runner: () => {
      runs++;
      if (runs === 2) controller.abort(); // stop after second tick
    },
    signal: controller.signal,
    log: () => {},
  });
  assert.equal(count, 2);
});

test("scheduler awaits async runners sequentially", async () => {
  const order: string[] = [];
  const count = await runScheduler({
    intervalMs: 10,
    maxRuns: 3,
    runner: async () => {
      order.push("start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("end");
    },
    log: () => {},
  });
  assert.equal(count, 3);
  assert.deepEqual(order, ["start", "end", "start", "end", "start", "end"]);
});

test("scheduler rejects invalid interval", async () => {
  await assert.rejects(
    () => runScheduler({ intervalMs: 0, runner: () => {} }),
    /intervalMs/,
  );
});
