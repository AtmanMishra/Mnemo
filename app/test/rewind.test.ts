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

// ── what a security review found ──

import * as os from "node:os";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkpointsExtension } from "../src/extensions/checkpoints.ts";
import { Checkpoints } from "../src/runtime/checkpoints.ts";

/** The checkpoint hook, then pi's real write tool, for one path spelling. */
async function writeAs(proj: string, store: Checkpoints, p: string, content: string) {
  let hook: ((event: unknown, ctx: unknown) => unknown) | undefined;
  checkpointsExtension({ checkpoints: store, depth: 0 } as never)({ on: (_: string, h: typeof hook) => (hook = h) } as never);
  const ctx = { cwd: proj, sessionManager: { getBranch: () => [{ id: "u1", type: "message", message: { role: "user" } }] } };
  const input = { path: p, content };
  hook!({ toolName: "write", input }, ctx);
  await createWriteToolDefinition(proj).execute("1", input, undefined, undefined, ctx as never);
}

test("a file written as @path or file:// is kept under the path the tool wrote", async () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ck-")));
  fs.mkdirSync(path.join(proj, "src"));
  fs.writeFileSync(path.join(proj, "src", "a.ts"), "original");
  fs.writeFileSync(path.join(proj, "src", "b.ts"), "original b");
  const store = new Checkpoints();
  await writeAs(proj, store, "@src/a.ts", "agent change");
  await writeAs(proj, store, `file://${proj}/src/b.ts`, "agent change b");
  expect(store.restore(["u1"]).sort()).toEqual([path.join(proj, "src", "a.ts"), path.join(proj, "src", "b.ts")]);
  expect(fs.readFileSync(path.join(proj, "src", "a.ts"), "utf8")).toBe("original");
  expect(fs.readFileSync(path.join(proj, "src", "b.ts"), "utf8")).toBe("original b");
});

test("a restore does not write through a symlink, and one file in the way does not stop the rest", () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ck-")));
  const outside = path.join(proj, "..", `${path.basename(proj)}-outside.txt`);
  fs.writeFileSync(outside, "do not touch");
  const a = path.join(proj, "a.txt");
  const b = path.join(proj, "b.txt");
  const c = path.join(proj, "c.txt");
  fs.writeFileSync(a, "a0");
  fs.writeFileSync(c, "c0");
  const store = new Checkpoints();
  store.turn = "u1";
  for (const f of [a, b, c]) store.keep(f);
  // Since then: a became a link out of the project, b (new) became a folder, c changed.
  fs.rmSync(a);
  fs.symlinkSync(outside, a);
  fs.mkdirSync(path.join(b, "inner"), { recursive: true });
  fs.writeFileSync(c, "c1");
  store.restore(["u1"]);
  expect(fs.readFileSync(outside, "utf8")).toBe("do not touch");
  expect(fs.lstatSync(a).isSymbolicLink()).toBe(false);
  expect(fs.readFileSync(a, "utf8")).toBe("a0");
  expect(fs.readFileSync(c, "utf8")).toBe("c0");
});
