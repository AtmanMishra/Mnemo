/** `mnemo background`: what background memory work did, and running it by hand. */
import { openSettings } from "../runtime/settings.ts";
import { dueTasks, type RunResult } from "./run.ts";
import { loadState, readEvents, TASKS, type BackgroundEvent } from "./store.ts";

export const BACKGROUND_USAGE = `mnemo background — memory work that runs while Mnemo is open

usage
  mnemo background                 whether it is on, when each task last ran, the latest results
  mnemo background log             every result kept
  mnemo background run [--force]   run the tasks that are due now (--force: all of them)

The tasks: ingest (learn from new Claude Code sessions; costs model calls), tidy (what
mnemo memory tidy would retire in recent projects) and curate (personal skills mnemo memory
curate would archive). Tidy and curate only report. Open conversations are told what each
run found with their next prompt.
Turn it on with mnemo settings set background on (backgroundEvery, backgroundModel tune it).`;

const when = (at: number | undefined) => (at === undefined ? "never" : new Date(at).toLocaleString());

function eventLines(e: BackgroundEvent): string[] {
  return [`${new Date(e.at).toLocaleString()}  ${e.task.padEnd(6)} ${e.name ? `${e.name}: ` : ""}${e.text}`, ...e.items.map((i) => `      · ${i}`)];
}

export async function backgroundCommand(argv: string[], home: string, run: (force: boolean) => Promise<RunResult>, out: (line: string) => void = console.log): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === "help") return out(BACKGROUND_USAGE), 0;
  if (sub === undefined || sub === "status") {
    const cfg = openSettings(home).get();
    const state = loadState(home);
    const due = new Set(dueTasks(state, cfg.backgroundEvery, Date.now()));
    out(`background work is ${cfg.background ? `on, every ${cfg.backgroundEvery} minutes` : "off (mnemo settings set background on)"}`);
    for (const t of TASKS) out(`  ${t.padEnd(7)} last ran ${when(state.last[t])}${cfg.background && due.has(t) ? " · due" : ""}`);
    const recent = readEvents(home).slice(-5);
    if (recent.length) out("\nlatest results");
    for (const e of recent) for (const l of eventLines(e)) out(l);
    return 0;
  }
  if (sub === "log") {
    const all = readEvents(home);
    if (!all.length) out("no results yet");
    for (const e of all) for (const l of eventLines(e)) out(l);
    return 0;
  }
  if (sub === "run") {
    const unknown = rest.find((a) => a !== "--force");
    if (unknown) return console.error(`mnemo background: unknown option ${unknown}\n${BACKGROUND_USAGE}`), 2;
    const r = await run(rest.includes("--force"));
    if (r.busy) return out("another Mnemo is running the background tasks now"), 0;
    if (!r.ran.length) return out("nothing is due"), 0;
    out(`ran ${r.ran.join(", ")}`);
    for (const e of r.events) for (const l of eventLines(e)) out(l);
    return r.events.some((e) => e.failed) ? 1 : 0;
  }
  console.error(`mnemo background: unknown command ${sub}\n${BACKGROUND_USAGE}`);
  return 2;
}
