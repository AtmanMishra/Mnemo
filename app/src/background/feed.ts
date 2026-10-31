/**
 * How open conversations hear about background work: each reads the events file (store.ts)
 * for what is new since it last looked. The interface shows a result when it lands; the
 * agent gets a short note with its next prompt (extensions/background.ts). And while the
 * `background` setting is on, an open Mnemo starts `mnemo background run` when a task is due.
 */
import * as fs from "node:fs";
import { selfCommand } from "../runtime/self.ts";
import type { SettingsStore } from "../runtime/settings.ts";
import { dueTasks } from "./run.ts";
import { loadState, lockFile, readEvents, type BackgroundEvent } from "./store.ts";

/** How often an open Mnemo looks for new results and due tasks. */
export const POLL_MS = 30_000;

/** Results after `since` that a conversation in project `project` should hear about. */
export function eventsFor(events: BackgroundEvent[], since: number, project: string | undefined): BackgroundEvent[] {
  return events.filter((e) => !e.failed && e.at > since && (!e.project || e.project === project));
}

/** The note an agent gets with its next prompt. */
export function backgroundMessage(events: BackgroundEvent[]): string {
  const lines = ["Background memory work finished since your last turn. What it learned is already in memory (memory_search finds it); what it only reported is for the user to apply."];
  for (const e of events) {
    lines.push(`- ${e.task}: ${e.text}`);
    for (const item of e.items) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}

/** Reads the events file and hands over each result once. */
export class BackgroundFeed {
  #since: number;
  constructor(
    private readonly home: string,
    since = Date.now(),
  ) {
    this.#since = since;
  }

  /** Results that arrived since the last poll (all projects). */
  poll(): BackgroundEvent[] {
    const fresh = readEvents(this.home).filter((e) => !e.failed && e.at > this.#since);
    if (fresh.length) this.#since = Math.max(...fresh.map((e) => e.at));
    return fresh;
  }
}

export interface WatchOptions {
  home: string;
  settings: SettingsStore;
  /** New results, as they land. */
  onEvents: (events: BackgroundEvent[]) => void;
  /** Starts `mnemo background run` (tests replace it). */
  start?: () => { exited: Promise<unknown> };
  now?: () => number;
  intervalMs?: number;
}

export function startRun(): { exited: Promise<unknown> } {
  return Bun.spawn([...selfCommand(), "background", "run"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

/** One look: deliver new results, and start a run when the setting is on and a task is due. */
export function backgroundTick(o: WatchOptions, feed: BackgroundFeed, running: { child?: Promise<unknown> }): void {
  const events = feed.poll();
  if (events.length) o.onEvents(events);
  const cfg = o.settings.get();
  if (!cfg.background || running.child) return;
  // Another process is running the tasks; it will write what it finds.
  if (fs.existsSync(lockFile(o.home))) return;
  if (!dueTasks(loadState(o.home), cfg.backgroundEvery, (o.now ?? Date.now)()).length) return;
  const child = (o.start ?? startRun)().exited.catch(() => {});
  running.child = child.finally(() => (running.child = undefined));
}

/** Looks every `intervalMs` until the returned function is called. */
export function watchBackground(o: WatchOptions): () => void {
  const feed = new BackgroundFeed(o.home, (o.now ?? Date.now)());
  const running: { child?: Promise<unknown> } = {};
  const tick = () => {
    try {
      backgroundTick(o, feed, running);
    } catch {
      /* an unreadable file is tried again next time */
    }
  };
  const timer = setInterval(tick, o.intervalMs ?? POLL_MS);
  timer.unref?.();
  // The first look soon after start, not a whole interval later.
  const first = setTimeout(tick, 2_000);
  first.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
