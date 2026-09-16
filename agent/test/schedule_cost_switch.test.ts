/**
 * Issue #8 (cost-budget auto-switch): an on_cost_over trigger that names a
 * fallback model must switch the job to it, not merely fire the expensive run
 * again to announce the spend. Real store, temp HOME, injected clock and cost
 * reader — no LLM, no real trace files.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tick, type FireContext } from "../src/schedule/daemon.ts";
import { loadJobs, saveJobs, describe, type ScheduleJob } from "../src/schedule/store.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-cost-switch-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const home = path.join(tmp, "home");
const now = () => 1_700_000_000_000;

function job(o: Partial<ScheduleJob>): ScheduleJob {
  return { id: "spend", name: "spend", prompt: "summarise spend", enabled: true, ...o };
}

function seed(jobs: ScheduleJob[]): void {
  saveJobs(home, jobs);
}

function ctx(cost: number, overrides: Partial<FireContext> = {}): FireContext {
  return {
    home,
    cwd: path.join(tmp, "repo"),
    now,
    costToday: async () => cost,
    runChild: async () => ({ ok: true, at: now(), durationMs: 5 }),
    log: () => {},
    ...overrides,
  };
}

test("crossing the budget switches the job to the fallback model, before the run", async () => {
  seed([
    job({
      model: "expensive-model",
      trigger: { type: "on_cost_over", params: { budget: 2.0, fallbackModel: "cheap-model" } },
    }),
  ]);
  const seen: (string | undefined)[] = [];
  const c = ctx(2.5, { runChild: async (j: ScheduleJob) => { seen.push(j.model); return { ok: true, at: now() }; } });

  const outcome = await tick(loadJobs(home)[0]!, c);

  assert.equal(outcome, "fired");
  // The run this trigger started must already be cheap: firing the expensive
  // model once more to report that it is too expensive helps nobody.
  assert.deepEqual(seen, ["cheap-model"], "the triggering run uses the fallback");
  // And it must persist, or the next tick pays full price again.
  assert.equal(loadJobs(home)[0]!.model, "cheap-model", "the switch is written to the store");
});

test("under budget nothing switches", async () => {
  seed([
    job({
      model: "expensive-model",
      trigger: { type: "on_cost_over", params: { budget: 5.0, fallbackModel: "cheap-model" } },
    }),
  ]);
  const seen: (string | undefined)[] = [];
  const c = ctx(1.2, { runChild: async (j: ScheduleJob) => { seen.push(j.model); return { ok: true, at: now() }; } });

  assert.equal(await tick(loadJobs(home)[0]!, c), "not-due");
  assert.deepEqual(seen, [], "nothing ran");
  assert.equal(loadJobs(home)[0]!.model, "expensive-model", "the model is untouched");
});

test("no fallback configured keeps yesterday's behaviour exactly", async () => {
  seed([job({ model: "expensive-model", trigger: { type: "on_cost_over", params: { budget: 2.0 } } })]);
  const seen: (string | undefined)[] = [];
  const c = ctx(9.9, { runChild: async (j: ScheduleJob) => { seen.push(j.model); return { ok: true, at: now() }; } });

  assert.equal(await tick(loadJobs(home)[0]!, c), "fired");
  assert.deepEqual(seen, ["expensive-model"], "the job still runs on its own model");
  assert.equal(loadJobs(home)[0]!.model, "expensive-model");
});

test("already on the fallback: no write, no repeat log", async () => {
  seed([
    job({
      model: "cheap-model",
      trigger: { type: "on_cost_over", params: { budget: 2.0, fallbackModel: "cheap-model" } },
    }),
  ]);
  const logs: string[] = [];
  const c = ctx(3.0, { log: (m) => logs.push(m) });

  assert.equal(await tick(loadJobs(home)[0]!, c), "fired");
  assert.equal(loadJobs(home)[0]!.model, "cheap-model");
  assert.ok(
    !logs.some((l) => l.includes("→")),
    "a job already on its fallback must not announce a switch that did not happen",
  );
});

test("the listing says what will happen when the budget is crossed", () => {
  const text = describe(job({ trigger: { type: "on_cost_over", params: { budget: 3, fallbackModel: "haiku" } } }));
  assert.match(text, /budget \$3/);
  assert.match(text, /→ haiku when over/);
});
