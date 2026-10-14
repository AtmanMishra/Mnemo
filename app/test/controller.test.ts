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
import { Controller, gitBranch } from "../src/runtime/controller.ts";
import { createDemoProject, createFaux, demoScript, DEMO_PROMPT } from "../src/runtime/demo.ts";
import { nextDialog } from "./helpers.ts";
import { setTheme } from "../src/ui/theme.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(cwd = createDemoProject(), o: { tokensPerSecond?: number; options?: Partial<ConstructorParameters<typeof Controller>[1]> } = {}) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { modelRuntime, faux } = await createFaux(agentDir, { tokensPerSecond: o.tokensPerSecond });
  const runtime = await startRuntime({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    sessionManager: SessionManager.inMemory(cwd),
  });
  let exited: number | undefined;
  const controller = new Controller(runtime, { exit: (c) => (exited = c ?? 0), ...o.options });
  await controller.bind();
  cleanups.push(() => runtime.dispose());
  return { controller, faux, cwd, exited: () => exited };
}

test("a scripted turn reads, edits, checks and answers, in order", async () => {
  const { controller, faux, cwd } = await setup();
  faux.setResponses(demoScript());
  await controller.submit(DEMO_PROMPT);
  await controller.session.waitForIdle();

  const snap = controller.transcript.snapshot();
  expect(snap.live).toEqual([]);
  expect(snap.working).toBeNull();
  const kinds = snap.committed.map((b) => (b.kind === "tool" ? `tool:${b.name}:${b.status}` : b.kind));
  expect(kinds).toEqual(["user", "thinking", "assistant", "tool:read:done", "tool:edit:done", "assistant", "tool:bash:done", "assistant"]);

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
  const dialog = await nextDialog(controller);
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notices = (c: Controller) => c.transcript.snapshot().committed.flatMap((b) => (b.kind === "notice" ? [b.text] : []));

test("esc with a message queued stops the run and puts the queued message back in the prompt", async () => {
  const { controller, faux } = await setup(undefined, { tokensPerSecond: 20 });
  faux.setResponses([fauxAssistantMessage(fauxText("word ".repeat(400))), fauxAssistantMessage(fauxText("SECOND"))]);
  const run = controller.submit("talk");
  await wait(300);
  await controller.submit("queued msg");
  expect(controller.transcript.snapshot().queue).toEqual(["queued msg"]);
  controller.interrupt();
  await run;
  await controller.session.waitForIdle();
  await wait(100);
  const snap = controller.transcript.snapshot();
  expect(snap.queue).toEqual([]);
  expect(controller.session.pendingMessageCount).toBe(0);
  expect(controller.draftText).toBe("queued msg");
  expect(controller.snapshot().draftRequest?.text).toBe("queued msg");
  const users = snap.committed.filter((b) => b.kind === "user").map((b) => (b as { text: string }).text);
  expect(users).toEqual(["talk"]);
});

/** A provider whose login waits on something outside Mnemo until it is aborted. */
function fakeLogin(controller: Controller, run: (i: { signal: AbortSignal; notify: (e: unknown) => void }) => Promise<unknown>) {
  const mr = controller.runtime.session.modelRuntime as unknown as Record<string, unknown>;
  mr.getProviders = () => [{ id: "acme", name: "Acme", auth: { oauth: { name: "Acme" } } }];
  mr.login = async (_id: string, _type: string, i: { signal: AbortSignal; notify: (e: unknown) => void }) => run(i);
}
const untilAborted = (signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));

test("a device-code login shows the code and a link, opens the page, and esc cancels the wait", async () => {
  const opened: string[] = [];
  const copied: string[] = [];
  const { controller } = await setup(undefined, { options: { openUrl: (u) => (opened.push(u), true), clipboard: (t) => void copied.push(t) } });
  fakeLogin(controller, async ({ signal, notify }) => {
    notify({ type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://acme.test/device" });
    return untilAborted(signal);
  });
  const pending = controller.submit("/login acme");
  await wait(50);
  expect(controller.dialogs.current()).toBeUndefined();
  const shown = controller.transcript.snapshot().committed.at(-1) as { kind: string; extra?: { code?: string; links?: { url: string }[] } };
  expect(shown.extra?.code).toBe("WDJB-MJHT");
  expect(shown.extra?.links?.[0]?.url).toBe("https://acme.test/device");
  expect(opened).toEqual(["https://acme.test/device"]);
  expect(copied).toEqual(["WDJB-MJHT"]);
  // Nothing on screen to back out of: esc is how the wait ends.
  expect(controller.transcript.isWorking).toBe(true);
  controller.interrupt();
  await pending;
  expect(notices(controller).at(-1)).toBe("Login cancelled");
  expect(controller.transcript.isWorking).toBe(false);
});

test("a sign-in URL is a link on its own line, not wrapped text, and a failure shows only pi's reason", async () => {
  const url = `https://claude.ai/oauth/authorize?${"x=1&".repeat(130)}state=abc`;
  const { controller } = await setup(undefined, { options: { openUrl: () => false, clipboard: () => {} } });
  fakeLogin(controller, async ({ notify }) => {
    notify({ type: "auth_url", url });
    notify({ type: "info", message: "Read the terms", links: [{ url: "https://acme.test/terms", label: "terms" }] });
    throw new Error("Token exchange failed: 400; stack=Error: at foo (x.js:1)\n at bar; details={...}");
  });
  await controller.submit("/login acme");
  const blocks = controller.transcript.snapshot().committed as unknown as { kind: string; text?: string; extra?: { links?: { url: string; label?: string }[] } }[];
  const link = blocks.find((b) => b.extra?.links?.[0]?.url === url);
  expect(link).toBeDefined();
  expect(link!.text).not.toContain(url);
  expect(blocks.find((b) => b.text === "Read the terms")?.extra?.links).toEqual([{ url: "https://acme.test/terms", label: "terms" }]);
  expect(notices(controller).at(-1)).toBe("Login failed: Token exchange failed: 400");
});

test("/compact on a session with nothing to compact says so once", async () => {
  const { controller } = await setup();
  await controller.submit("/compact");
  const said = notices(controller).filter((t) => /compact/i.test(t) && !/Compacting/.test(t));
  expect(said).toEqual(["Compaction failed: Nothing to compact (session too small)"]);
  expect(controller.transcript.isWorking).toBe(false);
});

test("esc stops a /compact, and a message sent meanwhile comes back to the prompt", async () => {
  const { controller, faux } = await setup(undefined, { tokensPerSecond: 20 });
  faux.setResponses([fauxAssistantMessage(fauxText("one")), fauxAssistantMessage(fauxText("two"))]);
  // Enough conversation that there is something to summarise past the recent turns pi keeps.
  await controller.submit(`first ${"lorem ipsum ".repeat(8000)}`);
  await controller.session.waitForIdle();
  await controller.submit(`second ${"dolor sit ".repeat(8000)}`);
  await controller.session.waitForIdle();
  faux.setResponses([fauxAssistantMessage(fauxText("summary ".repeat(400)))]);
  const compacting = controller.submit("/compact");
  await wait(200);
  expect(controller.session.isCompacting).toBe(true);
  // The working line is up, so the prompt's esc reaches interrupt().
  expect(controller.transcript.isWorking).toBe(true);
  await controller.submit("while compacting");
  expect(controller.draftText).toBe("while compacting");
  controller.interrupt();
  await compacting;
  expect(controller.session.isCompacting).toBe(false);
  expect(controller.transcript.isWorking).toBe(false);
  expect(notices(controller)).toContain("Compaction cancelled");
});

test("a built-in command that throws reports it instead of rejecting", async () => {
  const { controller } = await setup();
  (controller.session as unknown as { getSessionStats: () => never }).getSessionStats = () => {
    throw new Error("stats unavailable");
  };
  await controller.submit("/stats");
  await controller.submit("/cost");
  expect(notices(controller).slice(-2)).toEqual(["/stats failed: stats unavailable", "/cost failed: stats unavailable"]);
});

test("resuming a session file that cannot be read says so instead of rejecting", async () => {
  const { controller } = await setup();
  const before = controller.session.sessionFile;
  // A directory where the session file should be: reading it fails.
  await controller.resumePath(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-not-a-session-")));
  expect(notices(controller).at(-1)).toStartWith("Could not resume that session");
  expect(controller.session.sessionFile).toBe(before);
});

test("the branch is read through a worktree's .git file, and again after /new", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-wt-"));
  const gitdir = path.join(repo, "main-repo", ".git", "worktrees", "fix");
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/review/fix\n");
  const tree = path.join(repo, "tree");
  fs.mkdirSync(path.join(tree, "src"), { recursive: true });
  fs.writeFileSync(path.join(tree, ".git"), `gitdir: ${gitdir}\n`);
  expect(gitBranch(path.join(tree, "src"))).toBe("review/fix");
});

test("/new leaves nothing of the last session behind: statuses, activity, a waiting recall, the branch", async () => {
  const cwd = createDemoProject();
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { modelRuntime, faux } = await createFaux(agentDir);
  const status = (pi: { registerCommand: (n: string, o: unknown) => void }) =>
    pi.registerCommand("busy", { description: "", handler: async (_a: string, ctx: { ui: { setStatus: (k: string, t: string) => void; setWorkingMessage: (m: string) => void } }) => {
      ctx.ui.setStatus("ext", "indexing");
      ctx.ui.setWorkingMessage("Indexing…");
    } });
  const runtime = await startRuntime({ cwd, agentDir, modelRuntime, model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd), extensions: [status as never] });
  cleanups.push(() => runtime.dispose());
  const controller = new Controller(runtime, { exit: () => {} });
  await controller.bind();
  expect(controller.snapshot().footer.branch).toBe("main");
  await controller.submit("/busy");
  expect(controller.snapshot().statuses).toEqual([["ext", "indexing"]]);
  controller.transcript.memory("Recalled", ["from the old session"], { afterNextUser: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/feature\n");
  await controller.submit("/new");
  const chrome = controller.snapshot();
  expect(chrome.statuses).toEqual([]);
  expect(chrome.workingMessage).toBeUndefined();
  expect(chrome.footer.branch).toBe("feature");
  faux.setResponses([fauxAssistantMessage(fauxText("hi"))]);
  await controller.submit("hello");
  await controller.session.waitForIdle();
  expect(controller.transcript.snapshot().committed.some((b) => b.kind === "memory")).toBe(false);
});

test("an unknown command is caught, not sent to the model; a path is still words", async () => {
  const { controller, faux } = await setup();
  faux.setResponses([fauxAssistantMessage(fauxText("checked"))]);
  await controller.submit("/modle");
  expect(notices(controller).at(-1)).toBe("Unknown command /modle (/help lists them)");
  expect(controller.draftText).toBe("/modle");
  expect(faux.state.callCount).toBe(0);
  await controller.submit("/usr/bin/env is missing here");
  await controller.session.waitForIdle();
  expect(faux.state.callCount).toBe(1);
});

test("/theme takes a theme's shown name in any case, and says when there is none", async () => {
  const { controller } = await setup();
  const picked: string[] = [];
  (controller as unknown as { options: { onTheme: (n: string) => void } }).options.onTheme = (n) => void picked.push(n);
  try {
    await controller.submit("/theme Tokyo Night");
    await controller.submit("/theme DRACULA");
    expect(picked).toEqual(["tokyo", "dracula"]);
    await controller.submit("/theme bogus");
    expect(controller.dialogs.current()).toBeUndefined();
    expect(notices(controller).at(-1)).toBe("No theme called bogus. /theme lists them.");
  } finally {
    setTheme("night");
  }
});

test("/logout of a provider with no credentials says so instead of claiming it logged out", async () => {
  const { controller } = await setup();
  const out: string[] = [];
  const mr = controller.runtime.session.modelRuntime as unknown as Record<string, unknown>;
  mr.listCredentials = async () => [{ providerId: "anthropic", type: "api_key" }];
  mr.logout = async (id: string) => void out.push(id);
  await controller.submit("/logout typo");
  expect(out).toEqual([]);
  expect(notices(controller).at(-1)).toBe("No stored credentials for typo. Stored: anthropic.");
  await controller.submit("/logout anthropic");
  expect(out).toEqual(["anthropic"]);
});

test("/remember says it failed when memory did not keep it", async () => {
  const { controller } = await setup();
  const host = { mode: "default", memory: { learn: async () => undefined, stats: async () => undefined } };
  (controller as unknown as { options: { host: unknown } }).options.host = host;
  await controller.submit("/remember we deploy with fly");
  expect(notices(controller).at(-1)).toStartWith("Could not remember that");
  expect(controller.transcript.snapshot().committed.some((b) => b.kind === "memory" && b.title === "Remembered")).toBe(false);
});
