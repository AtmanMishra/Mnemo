/**
 * What a saved session was: a title, what it cost, how it ended. For /resume
 * and the Sessions pane, read from the session file pi wrote.
 */
import * as fs from "node:fs";

export type Outcome = "done" | "failed" | "stopped" | "open";

export interface SessionSummary {
  cost: number;
  outcome?: Outcome;
}

/** A short title from the first message: its first line, cut at a sentence end or 60 characters. */
export function titleFrom(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const clean = line.replace(/\s+/g, " ");
  const sentence = /^(.{12,60}?[.?!])(\s|$)/.exec(clean)?.[1];
  if (sentence) return sentence;
  return clean.length > 60 ? `${clean.slice(0, 59).replace(/\s+\S*$/, "")}…` : clean;
}

/** Read once per change of the file: the Sessions pane asks after every run. */
const cache = new Map<string, { mtime: number; summary: SessionSummary }>();

export function summarizeSession(file: string): SessionSummary {
  const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  if (mtime === undefined) return { cost: 0 };
  const hit = cache.get(file);
  if (hit?.mtime === mtime) return hit.summary;
  const summary = readSummary(file);
  cache.set(file, { mtime, summary });
  return summary;
}

function readSummary(file: string): SessionSummary {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { cost: 0 };
  }
  let cost = 0;
  let stop: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const m = (JSON.parse(line) as { message?: { role?: string; stopReason?: string; usage?: { cost?: { total?: number } } } }).message;
      if (m?.role !== "assistant") continue;
      cost += m.usage?.cost?.total ?? 0;
      stop = m.stopReason;
    } catch {
      /* a line being written */
    }
  }
  const outcome: Outcome | undefined =
    stop === undefined ? undefined : stop === "stop" ? "done" : stop === "error" ? "failed" : stop === "aborted" ? "stopped" : "open";
  return { cost, outcome };
}

const MARK: Record<Outcome, string> = { done: "✓", failed: "✗ failed", stopped: "■ stopped", open: "… unfinished" };

/** `$0.04 · ✓` */
export function summaryText(s: SessionSummary): string {
  return [s.cost > 0 ? `$${s.cost < 0.01 ? s.cost.toFixed(4) : s.cost.toFixed(2)}` : undefined, s.outcome && MARK[s.outcome]].filter(Boolean).join(" · ");
}
