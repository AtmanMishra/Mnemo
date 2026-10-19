import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cronNext, parseCron } from "../src/schedule/cron.ts";
import { scheduleCommand } from "../src/schedule/cli.ts";
import { isDue, jobArgs, runJob, takeLock, tick } from "../src/schedule/run.ts";
import { loadJobs, saveJobs, type Job } from "../src/schedule/store.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-sched-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const job = (over: Partial<Job> = {}): Job => ({ name: "j", cron: "* * * * *", prompt: "hi", cwd: os.tmpdir(), enabled: true, created: Date.now() - 3_600_000, ...over });
/** A job that runs a JS file with this runtime, never a shell script. */
const node = (script: string) => (j: Job) => [process.execPath, "-e", script, j.name];

test("cron: steps, lists, ranges and the next minute after a time", () => {
  const next = (expr: string, from: string) => cronNext(parseCron(expr), new Date(from));
  expect(next("*/15 * * * *", "2026-03-04T10:07:00")?.getMinutes()).toBe(15);
  expect(next("30 9 * * 1-5", "2026-03-06T10:00:00")?.getDate()).toBe(9); // Friday after 09:30 -> Monday
  expect(next("0 0 1 1 *", "2026-03-04T10:00:00")?.getFullYear()).toBe(2027);
  expect(next("5,10 * * * *", "2026-03-04T10:05:00")?.getMinutes()).toBe(10);
  expect(next("0 0 31 2 *", "2026-03-04T10:00:00")).toBeUndefined();
});

test("cron: day-of-month and weekday both set means either", () => {
  const d = cronNext(parseCron("0 0 13 * 5"), new Date("2026-03-01T00:00:00"));
  expect(d?.getDate()).toBe(6); // the first Friday comes before the 13th
});

test("cron: refuses malformed expressions", () => {
  for (const bad of ["* * * *", "61 * * * *", "* 24 * * *", "*/0 * * * *", "a * * * *", "5-1 * * * *", "* * * * * *"]) expect(() => parseCron(bad)).toThrow();
});

test("a job is due once its next window has passed, and fires once for many missed windows", async () => {
  const home = tmp();
  saveJobs(home, [job({ cron: "*/5 * * * *", created: Date.now() - 3 * 3_600_000 })]);
  expect(isDue(loadJobs(home)[0], Date.now())).toBe(true);
  const runs: string[] = [];
  const fake = async (_h: string, name: string) => {
    runs.push(name);
    const jobs = loadJobs(home);
    jobs[0].lastRun = Date.now();
    saveJobs(home, jobs);
    return { code: 0, log: "" };
  };
  expect(await tick(home, Date.now(), fake)).toEqual(["j"]);
  expect(await tick(home, Date.now(), fake)).toEqual([]);
  expect(runs).toEqual(["j"]);
});

test("a disabled job never runs", () => {
  expect(isDue(job({ enabled: false }), Date.now())).toBe(false);
});

test("an unattended run is read-only unless the job allows actions", () => {
  expect(jobArgs(job())).toContain("--plan");
  expect(jobArgs(job({ actions: true }))).not.toContain("--plan");
  expect(jobArgs(job({ actions: true }))).not.toContain("--yolo");
});

test("a run stores lastRun first, logs the output redacted and keeps the log private", async () => {
  const home = tmp();
  saveJobs(home, [job()]);
  const secret = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  const r = await runJob(home, "j", node(`console.log("done ${secret}"); process.exit(3)`));
  expect(r.code).toBe(3);
  const text = fs.readFileSync(r.log, "utf8");
  expect(text).toContain("exit 3");
  expect(text).toContain("done");
  expect(text).not.toContain(secret);
  if (process.platform !== "win32") expect(fs.statSync(r.log).mode & 0o077).toBe(0);
  expect(loadJobs(home)[0].lastRun).toBeGreaterThan(Date.now() - 60_000);
});

test("only the newest 20 logs are kept", async () => {
  const home = tmp();
  saveJobs(home, [job()]);
  const dir = path.join(home, "schedules", "logs", "j");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(dir, `2020-01-01T00-00-${String(i).padStart(2, "0")}.log`), "x");
  await runJob(home, "j", node("0"));
  expect(fs.readdirSync(dir).length).toBe(20);
});

test("a run that outlives its timeout is stopped", async () => {
  const home = tmp();
  saveJobs(home, [job({ timeout: 0.01 })]);
  const r = await runJob(home, "j", node("setTimeout(()=>{}, 60000)"));
  expect(r.code).not.toBe(0);
}, 20000);

test("the lock admits one scheduler and is taken over from a dead one", () => {
  const home = tmp();
  const release = takeLock(home)!;
  expect(release).toBeDefined();
  expect(takeLock(home)).toBeUndefined();
  release();
  fs.mkdirSync(path.join(home, "schedules"), { recursive: true });
  fs.writeFileSync(path.join(home, "schedules", "daemon.lock"), "2147483646");
  expect(takeLock(home)).toBeDefined();
});

test("the CLI adds, lists, disables and removes; a bad cron or name is refused", async () => {
  const home = tmp();
  const cwd = fs.realpathSync(tmp());
  const quiet = async (argv: string[]) => {
    const log = console.log, err = console.error;
    console.log = console.error = () => {};
    try {
      return await scheduleCommand(argv, home);
    } finally {
      console.log = log;
      console.error = err;
    }
  };
  expect(await quiet(["add", "nightly", "0 3 * * *", "check the tests", "--cwd", cwd])).toBe(0);
  expect(loadJobs(home)[0]).toMatchObject({ name: "nightly", cwd, actions: false, enabled: true });
  expect(await quiet(["add", "nightly", "0 3 * * *", "again", "--cwd", cwd])).toBe(1);
  expect(await quiet(["add", "bad", "61 * * * *", "x", "--cwd", cwd])).toBe(1);
  expect(await quiet(["add", "../evil", "0 3 * * *", "x", "--cwd", cwd])).toBe(1);
  expect(await quiet(["add", "nofolder", "0 3 * * *", "x", "--cwd", path.join(cwd, "missing")])).toBe(1);
  expect(await quiet(["disable", "nightly"])).toBe(0);
  expect(loadJobs(home)[0].enabled).toBe(false);
  expect(await quiet(["remove", "nightly"])).toBe(0);
  expect(loadJobs(home)).toEqual([]);
  expect(await quiet(["remove", "nightly"])).toBe(1);
});

test("a hand-edited schedules.json with a broken entry drops only that entry", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "schedules.json"), JSON.stringify([{ name: "ok", cron: "0 * * * *", prompt: "p", cwd: "/" }, { name: "bad", cron: "nope", prompt: "p", cwd: "/" }, 7]));
  expect(loadJobs(home).map((j) => j.name)).toEqual(["ok"]);
});
