/**
 * /stats: this session's totals, a sparkline of the last seven days' spend
 * from the daily logs, and which tools failed.
 */
import { test, expect, afterEach } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { sparkline, statsText } from "../src/runtime/stats.ts";
import { mnemoEnv, texts } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

test("the dashboard from logs", () => {
  expect(sparkline([0, 1, 2, 4, 8])).toBe(" ▂▃▅█");
  const day = (d: string, records: object[]) => ({ day: d, records: records as never });
  const text = statsText({
    session: { id: "s1", turns: 2, toolCalls: 3, input: 12_000, output: 800, cacheRead: 0, cost: 0.05 },
    days: [
      day("2026-10-06", [{ ts: "", session: "s0", type: "turn", cost: 0.1 }]),
      day("2026-10-07", []),
      day("2026-10-08", [
        { ts: "", session: "s1", type: "turn", cost: 0.05 },
        { ts: "", session: "s1", type: "tool", tool: "bash", ok: false },
        { ts: "", session: "s1", type: "tool", tool: "bash", ok: true },
        { ts: "", session: "s1", type: "tool", tool: "read", ok: true },
      ]),
    ],
    memory: { nodes: 40, recalled: 2 },
  });
  expect(text).toContain("This session  2 turns · 3 tool calls (1 failed) · 12k in / 800 out · $0.05");
  expect(text).toContain("Last 7 days   █ ▅  $0.15 · 2 model calls · 2 sessions");
  expect(text).toContain("Tools         bash 2 (1 ✗) · read 1");
  expect(text).toContain("Memory        40 nodes · 2 recalled this session");
});

test("/stats on a real session reads what the trace logged", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  e.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "exit 3" })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("run it");
  await e.idle();
  await e.controller.submit("/stats");
  const out = texts(e.controller).at(-1)!;
  expect(out).toContain("This session  1 turn · 1 tool call (1 failed)");
  expect(out).toContain("bash 1 (1 ✗)");
});
