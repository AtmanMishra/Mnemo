/**
 * Rewind: back to before an earlier message. The files the agent changed since
 * go back (a new file goes away), the conversation moves to that point, and the
 * message returns to the prompt. "Conversation only" leaves the files alone.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { mnemoEnv, nextDialog } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));

async function twoTurns() {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  const a = path.join(e.cwd, "a.txt");
  fs.writeFileSync(a, "zero\n");
  e.faux.setResponses([call("write", { path: "a.txt", content: "one\n" }), say("wrote one")]);
  await e.controller.submit("first: make it one");
  await e.idle();
  e.faux.setResponses([call("edit", { path: "a.txt", edits: [{ oldText: "one", newText: "two" }] }), call("write", { path: "b.txt", content: "new\n" }), say("done")]);
  await e.controller.submit("second: make it two and add b");
  await e.idle();
  expect(fs.readFileSync(a, "utf8")).toBe("two\n");
  return { e, a, b: path.join(e.cwd, "b.txt") };
}

async function pick(e: Awaited<ReturnType<typeof mnemoEnv>>, match: (label: string) => boolean) {
  const d = await nextDialog(e.controller);
  if (d.kind !== "select") throw new Error(`expected a select, got ${d.kind}`);
  const c = d.choices.find((c) => match(c.label));
  if (!c) throw new Error(`no choice in ${d.choices.map((c) => c.label).join(", ")}`);
  d.resolve(c.value);
  return d;
}

test("rewinding to the second message puts back its files and its words", async () => {
  const { e, a, b } = await twoTurns();
  const done = e.controller.rewind();
  const list = await pick(e, (l) => l.startsWith("second"));
  if (list.kind === "select") expect(list.choices.map((c) => c.description)).toEqual(["2 files changed since", "2 files changed since"]);
  await pick(e, (l) => l.startsWith("The conversation and"));
  await done;
  expect(fs.readFileSync(a, "utf8")).toBe("one\n");
  expect(fs.existsSync(b)).toBe(false);
  const users = e.controller.runtime.session.messages.filter((m) => m.role === "user");
  expect(users).toHaveLength(1);
  expect(e.controller.snapshot().draftRequest?.text).toBe("second: make it two and add b");
  const notices = e.controller.transcript.snapshot().committed.filter((x) => x.kind === "notice").map((x) => ("text" in x ? x.text : ""));
  expect(notices.at(-1)).toContain("Rewound the conversation and 2 files");
});

test("to the first message restores the file as it was before either turn", async () => {
  const { e, a, b } = await twoTurns();
  const done = e.controller.rewind();
  await pick(e, (l) => l.startsWith("first"));
  await pick(e, (l) => l.startsWith("Only the"));
  await done;
  expect(fs.readFileSync(a, "utf8")).toBe("zero\n");
  expect(fs.existsSync(b)).toBe(false);
  expect(e.controller.runtime.session.messages.filter((m) => m.role === "user")).toHaveLength(2);
});

test("conversation only leaves the files as they are", async () => {
  const { e, a } = await twoTurns();
  const done = e.controller.rewind();
  await pick(e, (l) => l.startsWith("second"));
  await pick(e, (l) => l.startsWith("The conversation only"));
  await done;
  expect(fs.readFileSync(a, "utf8")).toBe("two\n");
  expect(e.controller.runtime.session.messages.filter((m) => m.role === "user")).toHaveLength(1);
});
