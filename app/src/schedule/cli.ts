/** `mnemo schedule …`: jobs that run a prompt on a timer. */
import * as fs from "node:fs";
import * as path from "node:path";
import { openSettings } from "../runtime/settings.ts";
import { parseCron } from "./cron.ts";
import { daemon, logDir, nextRun, runJob, tick } from "./run.ts";
import { loadJobs, saveJobs, validName, type Job } from "./store.ts";

export const SCHEDULE_USAGE = `mnemo schedule — run a prompt on a timer

usage
  mnemo schedule add <name> "<cron>" "<prompt>" [--cwd <dir>] [--actions] [--timeout <minutes>]
  mnemo schedule list
  mnemo schedule remove|enable|disable <name>
  mnemo schedule run <name>        run one job now
  mnemo schedule run --once        run what is due and exit (for cron, systemd, launchd, Task Scheduler)
  mnemo schedule run               stay running and check every 30 seconds
  mnemo schedule logs <name>       the newest log

The cron has five fields (minute hour day month weekday), in local time.
A job is read-only unless added with --actions; then it may edit files and run commands
under the same permission gate and rules as any other run. -p allows what would ask,
so give an acting job a budget first: mnemo settings runSpend 0.50.
Jobs are kept in ~/.mnemo/schedules.json; a folder cannot add one.`;

export async function scheduleCommand(argv: string[], home: string): Promise<number> {
  const [sub, ...rest] = argv;
  const fail = (msg: string) => (console.error(`mnemo schedule: ${msg}`), 1);
  try {
    if (sub === "add") {
      let cwd = process.cwd();
      let actions = false;
      let timeout: number | undefined;
      const pos: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--cwd") cwd = path.resolve(rest[++i] ?? "");
        else if (rest[i] === "--actions") actions = true;
        else if (rest[i] === "--timeout") timeout = Number(rest[++i]);
        else pos.push(rest[i]);
      }
      const [name, cron, prompt] = pos;
      if (!name || !cron || !prompt || pos.length > 3) return fail(`add needs <name> "<cron>" "<prompt>"\n${SCHEDULE_USAGE}`);
      if (!validName(name)) return fail("a name is letters, digits, . _ - (up to 64)");
      if (timeout !== undefined && !(timeout > 0)) return fail("--timeout is a number of minutes");
      parseCron(cron);
      if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return fail(`${cwd} is not a folder`);
      const jobs = loadJobs(home);
      if (jobs.some((j) => j.name === name)) return fail(`"${name}" exists; remove it first`);
      jobs.push({ name, cron, prompt, cwd: fs.realpathSync(cwd), actions, timeout, enabled: true, created: Date.now() });
      saveJobs(home, jobs);
      console.log(`added ${name}; next run ${nextRun(jobs[jobs.length - 1])?.toLocaleString() ?? "never"}`);
      if (actions) {
        console.log("this job may edit files and run commands without anyone watching, under the permission gate.");
        if (openSettings(home).get().runSpend === 0) console.log("there is no run budget: mnemo settings runSpend <dollars> caps what one run may spend.");
      }
      return 0;
    }
    if (sub === "--help" || sub === "help") return console.log(SCHEDULE_USAGE), 0;
    if (sub === "list" || sub === undefined) {
      const jobs = loadJobs(home);
      if (!jobs.length) return console.log("no scheduled jobs"), 0;
      for (const j of jobs) console.log(`${j.name}\t${j.cron}\t${j.enabled ? "on" : "off"}\t${j.actions ? "acts" : "read-only"}\tnext ${nextRun(j)?.toLocaleString() ?? "never"}\t${j.cwd}`);
      return 0;
    }
    if (sub === "remove" || sub === "enable" || sub === "disable") {
      const jobs = loadJobs(home);
      const job = jobs.find((j) => j.name === rest[0]);
      if (!job) return fail(`no job named "${rest[0] ?? ""}"`);
      if (sub === "remove") saveJobs(home, jobs.filter((j) => j !== job));
      else {
        job.enabled = sub === "enable";
        // Enabling starts the clock now: it must not fire for every window missed while it was off.
        if (job.enabled) job.lastRun = Date.now();
        saveJobs(home, jobs);
      }
      return console.log(`${job.name}: ${sub === "remove" ? "removed" : sub === "enable" ? "enabled" : "disabled"}`), 0;
    }
    if (sub === "run") {
      if (rest[0] === "--once") {
        const ran = await tick(home);
        console.log(ran.length ? `ran ${ran.join(", ")}` : "nothing due");
        return 0;
      }
      if (rest[0]) {
        const r = await runJob(home, rest[0]);
        console.log(`exit ${r.code}; log ${r.log}`);
        return r.code;
      }
      const stop = new AbortController();
      process.on("SIGINT", () => stop.abort());
      process.on("SIGTERM", () => stop.abort());
      return daemon(home, stop.signal, (line) => console.log(`${new Date().toISOString()} ${line}`));
    }
    if (sub === "logs") {
      const dir = logDir(home, rest[0] ?? "");
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
      if (!files.length) return fail(`no logs for "${rest[0] ?? ""}"`);
      console.log(fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8"));
      return 0;
    }
    return fail(`unknown command "${sub}"\n${SCHEDULE_USAGE}`);
  } catch (e) {
    return fail((e as Error).message);
  }
}
