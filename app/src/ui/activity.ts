/**
 * What a transcript says about the work, as data for pixels: one outcome per
 * turn (the timeline, the hub's strips) and the counts a test run printed
 * (the heatmap). Pure, so tests read it without a terminal.
 */
import type { Block } from "./store.ts";

export type Outcome = "ok" | "failed" | "escalated" | "running" | "empty";

export interface Turn {
  /** Index of the turn's user block in the list it came from. */
  at: number;
  prompt: string;
  outcome: Outcome;
  tools: number;
}

/**
 * Split blocks into turns at each user message. A turn failed when its last
 * tool call failed or it ended on an error notice; it escalated when a notice
 * says so; it is running while it is the last turn and work is going on.
 */
export function turns(blocks: readonly Block[], working = false): Turn[] {
  const out: Turn[] = [];
  let cur: (Turn & { lastTool?: "done" | "error"; error?: boolean; escalated?: boolean }) | undefined;
  const close = () => {
    if (!cur) return;
    const outcome: Outcome = cur.escalated ? "escalated" : cur.error || cur.lastTool === "error" ? "failed" : "ok";
    out.push({ at: cur.at, prompt: cur.prompt, outcome, tools: cur.tools });
  };
  blocks.forEach((b, i) => {
    if (b.kind === "user") {
      close();
      cur = { at: i, prompt: b.text, outcome: "ok", tools: 0 };
      return;
    }
    if (!cur) return;
    if (b.kind === "tool") {
      cur.tools++;
      if (b.status === "done" || b.status === "error") cur.lastTool = b.status;
    } else if (b.kind === "notice") {
      if (b.tone === "error") cur.error = true;
      if (/escalat/i.test(b.text)) cur.escalated = true;
    } else if (b.kind === "memory" && /escalat/i.test(b.title)) cur.escalated = true;
    else if (b.kind === "assistant" && b.text.trim()) cur.error = false;
  });
  close();
  if (working && out.length) out[out.length - 1] = { ...out[out.length - 1]!, outcome: "running" };
  return out;
}

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * Pass and fail counts from what common runners print: bun/vitest/jest
 * ("12 pass", "Tests: 1 failed, 4 passed"), pytest ("3 passed, 1 failed"),
 * go ("ok"/"FAIL" per package), cargo ("test result: ok. 9 passed; 0 failed").
 * Undefined when the output is not a test run.
 */
export function testCounts(output: string): TestCounts | undefined {
  const num = (re: RegExp) => {
    let n = 0;
    let seen = false;
    for (const m of output.matchAll(re)) {
      n += Number(m[1]);
      seen = true;
    }
    return seen ? n : undefined;
  };
  // bun test: " 12 pass" / " 1 fail" on their own lines
  const bunPass = num(/^\s*(\d+) pass\s*$/gm);
  const bunFail = num(/^\s*(\d+) fail\s*$/gm);
  if (bunPass !== undefined || bunFail !== undefined) return { passed: bunPass ?? 0, failed: bunFail ?? 0, skipped: num(/^\s*(\d+) skip\s*$/gm) ?? 0 };
  const passed = num(/(\d+) passed/g);
  const failed = num(/(\d+) failed/g);
  if (passed !== undefined || failed !== undefined) return { passed: passed ?? 0, failed: failed ?? 0, skipped: num(/(\d+) skipped/g) ?? 0 };
  const goOk = (output.match(/^ok\s+\S+/gm) ?? []).length;
  const goFail = (output.match(/^FAIL\s+\S+/gm) ?? []).length;
  if (goOk + goFail > 0) return { passed: goOk, failed: goFail, skipped: 0 };
  return undefined;
}
