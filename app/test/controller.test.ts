/**
 * A whole turn through the real pi agent loop with a scripted model: the
 * events reach the transcript in order, tools really run, and everything ends
 * up committed once the run settles.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { startRuntime } from "../src/runtime/runtime.ts";
import { Controller } from "../src/runtime/controller.ts";
import { createDemoProject, createFaux, demoScript, DEMO_PROMPT } from "../src/runtime/demo.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(cwd = createDemoProject()) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { modelRuntime, faux } = await createFaux(agentDir);
  const runtime = await startRuntime({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    sessionManager: SessionManager.inMemory(cwd),
  });
  let exited: number | undefined;
  const controller = new Controller(runtime, { exit: (c) => (exited = c ?? 0) });
  await controller.bind();
  cleanups.push(() => runtime.dispose());
  return { controller, faux, cwd, exited: () => exited };
}

test("a scripted turn reads, edits and answers, in order", async () => {
  const { controller, faux, cwd } = await setup();
  faux.setResponses(demoScript());
  await controller.submit(DEMO_PROMPT);
  await controller.session.waitForIdle();

  const snap = controller.transcript.snapshot();
  expect(snap.live).toEqual([]);
  expect(snap.working).toBeNull();
  const kinds = snap.committed.map((b) => (b.kind === "tool" ? `tool:${b.name}:${b.status}` : b.kind));
  expect(kinds).toEqual(["user", "thinking", "assistant", "tool:read:done", "tool:edit:done", "assistant"]);

  const edit = snap.committed.find((b) => b.kind === "tool" && b.name === "edit");
  expect((edit as { details?: { diff?: string } }).details?.diff).toContain("attempt");
  expect(fs.readFileSync(path.join(cwd, "src", "fetch.ts"), "utf8")).toContain("attempt === 3");
});

test("a message typed while the agent works is queued, then delivered", async () => {
  const { controller, faux } = await setup();
  faux.setResponses([fauxAssistantMessage(fauxText("first")), fauxAssistantMessage(fauxText("second"))]);
  const run = controller.submit("one");
  await new Promise((r) => setTimeout(r, 0));
  await controller.submit("two");
  await run;
  await controller.session.waitForIdle();
  const users = controller.transcript.snapshot().committed.filter((b) => b.kind === "user").map((b) => (b as { text: string }).text);
  expect(users).toEqual(["one", "two"]);
});

test("built-in commands answer without reaching the model", async () => {
  const { controller, faux, exited } = await setup();
  faux.setResponses([]);
  await controller.submit("/help");
  const last = controller.transcript.snapshot().committed.at(-1);
  expect(last?.kind).toBe("notice");
  expect((last as { text: string }).text).toContain("/model");
  expect(faux.state.callCount).toBe(0);
  await controller.submit("/quit");
  expect(exited()).toBe(0);
});

test("the slash menu lists built-ins first", async () => {
  const { controller } = await setup();
  const names = controller.commands().map((c) => c.name);
  expect(names.slice(0, 3)).toEqual(["help", "model", "thinking"]);
});

test("/model picks from the available models through a dialog", async () => {
  const { controller } = await setup();
  const pending = controller.submit("/model");
  await new Promise((r) => setTimeout(r, 10));
  const dialog = controller.dialogs.current();
  expect(dialog?.kind).toBe("select");
  if (dialog?.kind !== "select") throw new Error("no dialog");
  expect(dialog.choices.map((c) => c.value)).toContain("mnemo-demo/demo-model");
  dialog.resolve("mnemo-demo/demo-model");
  await pending;
  expect(controller.snapshot().footer.model).toBe("demo-model");
});

test("with no credentials anywhere, a prompt is answered with /login, not sent", async () => {
  // pi finds ambient credentials in the environment (AWS profiles, *_API_KEY);
  // this is the machine of someone who has none.
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/API_KEY|^AWS_|^GOOGLE|^AZURE|^GEMINI|TOKEN/.test(k)) delete process.env[k];
  try {
    const cwd = createDemoProject();
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    const runtime = await startRuntime({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
    cleanups.push(() => runtime.dispose());
    const controller = new Controller(runtime, { exit: () => {} });
    await controller.bind();
    expect(controller.hasModel).toBe(false);
    expect(controller.snapshot().footer.model).toBe("no model");
    await controller.submit("hello");
    const last = controller.transcript.snapshot().committed.at(-1) as { kind: string; text: string };
    expect(last.kind).toBe("notice");
    expect(last.text).toContain("/login");
  } finally {
    process.env = saved;
  }
});

test("/login runs pi's own flow through the dialogs, and backing out is not an error", async () => {
  const { controller } = await setup();
  const pending = controller.submit("/login anthropic");
  const next = async () => {
    for (let i = 0; i < 50 && !controller.dialogs.current(); i++) await new Promise((r) => setTimeout(r, 10));
    return controller.dialogs.current();
  };
  const method = await next();
  expect(method?.kind).toBe("select");
  if (method?.kind !== "select") throw new Error("no method dialog");
  method.resolve("api_key");
  const key = await next();
  expect(key?.kind).toBe("text");
  if (key?.kind !== "text") throw new Error("no key dialog");
  expect(key.secret).toBe(true);
  key.resolve(undefined);
  await pending;
  const last = controller.transcript.snapshot().committed.at(-1) as { tone: string; text: string };
  expect(last.text).toBe("Login cancelled");
  expect(last.tone).toBe("info");
});

test("interrupting a streaming answer stops it and says so", async () => {
  const cwd = createDemoProject();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { modelRuntime, faux } = await createFaux(agentDir, { tokensPerSecond: 20 });
  const runtime = await startRuntime({ cwd, agentDir, modelRuntime, model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd) });
  cleanups.push(() => runtime.dispose());
  const controller = new Controller(runtime, { exit: () => {} });
  await controller.bind();
  faux.setResponses([fauxAssistantMessage(fauxText("word ".repeat(400)))]);
  const run = controller.submit("talk for a while");
  await new Promise((r) => setTimeout(r, 300));
  expect(controller.transcript.snapshot().working).not.toBeNull();
  controller.interrupt();
  await run;
  await controller.session.waitForIdle();
  const snap = controller.transcript.snapshot();
  expect(snap.working).toBeNull();
  expect(snap.live).toEqual([]);
  expect(snap.committed.some((b) => b.kind === "notice" && b.text === "Interrupted")).toBe(true);
});

test("/new starts over and /resume brings the earlier conversation back", async () => {
  const cwd = createDemoProject();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { modelRuntime, faux } = await createFaux(agentDir);
  // A persistent session this time: /resume reads what is on disk.
  const runtime = await startRuntime({ cwd, agentDir, modelRuntime, model: faux.getModel() });
  cleanups.push(() => runtime.dispose());
  const controller = new Controller(runtime, { exit: () => {} });
  await controller.bind();
  faux.setResponses([fauxAssistantMessage(fauxText("the answer is 42"))]);
  await controller.submit("what is the answer?");
  await controller.session.waitForIdle();
  const first = controller.session.sessionFile;

  await controller.submit("/new");
  expect(controller.session.sessionFile).not.toBe(first);
  expect(controller.transcript.snapshot().committed.map((b) => b.kind)).toEqual(["notice"]);

  const pending = controller.submit("/resume");
  for (let i = 0; i < 50 && !controller.dialogs.current(); i++) await new Promise((r) => setTimeout(r, 10));
  const dialog = controller.dialogs.current();
  if (dialog?.kind !== "select") throw new Error("no session list");
  expect(dialog.choices[0]?.label).toContain("what is the answer?");
  dialog.resolve(dialog.choices[0]!.value);
  await pending;
  expect(controller.session.sessionFile).toBe(first);
  const texts = controller.transcript
    .snapshot()
    .committed.map((b) => ("text" in b ? b.text : b.kind));
  expect(texts).toEqual(["what is the answer?", "the answer is 42", "Resumed session"]);
});
