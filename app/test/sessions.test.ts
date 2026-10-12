/**
 * Saved sessions: a title from the first message (and the session is named
 * after its first run), what it cost and how it ended, and /resume finds a
 * session by anything that was said in it.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { summarizeSession, summaryText, titleFrom } from "../src/runtime/sessions.ts";
import { filterChoices } from "../src/ui/components/Dialogs.tsx";
import { mnemoEnv, nextDialog } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

test("titles", () => {
  expect(titleFrom("\n  Fix the flaky login test. It fails on CI\nmore")).toBe("Fix the flaky login test.");
  expect(titleFrom("refactor the payment module so that retries are handled in one place instead of three")).toBe("refactor the payment module so that retries are handled in…");
  expect(titleFrom("hi")).toBe("hi");
});

test("cost and outcome come from the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-sess-"));
  const file = path.join(dir, "s.jsonl");
  const msg = (stopReason: string, total: number) => JSON.stringify({ type: "message", message: { role: "assistant", stopReason, usage: { cost: { total } } } });
  fs.writeFileSync(file, [JSON.stringify({ type: "session" }), msg("toolUse", 0.01), msg("stop", 0.03)].join("\n"));
  expect(summaryText(summarizeSession(file))).toBe("$0.04 · ✓");
  fs.appendFileSync(file, `\n${msg("error", 0.02)}`);
  expect(summaryText(summarizeSession(file))).toBe("$0.06 · ✗ failed");
  expect(filterChoices([{ value: "a", label: "x", keywords: "we fixed the walrus parser" }, { value: "b", label: "y" }], "walrus").map((c) => c.value)).toEqual(["a"]);
});

test("a session is named after its first message, and /resume lists it with that name", async () => {
  const e = await mnemoEnv({ persistent: true });
  envs.push(e);
  e.faux.setResponses([fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("Fix the flaky login test. It fails on CI");
  await e.idle();
  await new Promise((r) => setTimeout(r, 50));
  expect(e.controller.runtime.session.sessionManager.getSessionName()).toBe("Fix the flaky login test.");
  await e.controller.submit("/new");
  const resuming = e.controller.submit("/resume");
  const d = await nextDialog(e.controller);
  if (d.kind !== "select") throw new Error(d.kind);
  expect(d.choices[0]!.label).toBe("Fix the flaky login test.");
  expect(d.choices[0]!.description).toContain("✓");
  expect(filterChoices(d.choices, "fails on CI")).toHaveLength(1);
  d.resolve(undefined);
  await resuming;
});
