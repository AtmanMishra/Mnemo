/**
 * Mnemo's behaviour on pi, end to end with a scripted model: the gate, the
 * memory loop across two sessions, the Python kernel, sub-agents and skills.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { judge, globMatch, matchRule } from "../src/extensions/policy.ts";
import { factsOf } from "../src/memory/service.ts";
import { MEMSRV, mnemoEnv, nextDialog, texts } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
async function env(o: Parameters<typeof mnemoEnv>[0] = {}) {
  const e = await mnemoEnv(o);
  envs.push(e);
  return e;
}
const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
const memoryTest = MEMSRV ? test : test.skip;

// ── the gate, as a pure decision ──────────────────────────────────────────────

const noGrants = { project: [], global: [], deny: [] };

test("reading is free; edits and commands ask in the default mode", () => {
  const host = { mode: "default" as const };
  expect(judge(host, [], noGrants, "/p", "read", { path: "a.ts" })).toEqual({ allow: true });
  expect("ask" in judge(host, [], noGrants, "/p", "edit", { path: "a.ts", edits: [] })).toBe(true);
  expect("ask" in judge(host, [], noGrants, "/p", "bash", { command: "npm test" })).toBe(true);
});

test("plan mode refuses changes and says how to leave it", () => {
  const v = judge({ mode: "plan" }, [], noGrants, "/p", "write", { path: "a.ts", content: "x" });
  expect(v).toMatchObject({ allow: false });
  expect((v as { reason: string }).reason).toContain("shift+tab");
  expect(judge({ mode: "plan" }, [], noGrants, "/p", "grep", { pattern: "x" })).toEqual({ allow: true });
});

test("accept-edits allows edits inside the project only", () => {
  expect(judge({ mode: "accept-edits" }, [], noGrants, "/p", "edit", { path: "src/a.ts" })).toEqual({ allow: true });
  expect("ask" in judge({ mode: "accept-edits" }, [], noGrants, "/p", "edit", { path: "/etc/hosts" })).toBe(true);
  expect("ask" in judge({ mode: "accept-edits" }, [], noGrants, "/p", "bash", { command: "ls" })).toBe(true);
});

test("a deny rule beats every mode, yolo included", () => {
  const rules = [{ tool: "bash", pattern: "rm -rf*", action: "deny" as const }];
  expect(judge({ mode: "yolo" }, rules, noGrants, "/p", "bash", { command: "rm -rf /" })).toMatchObject({ allow: false });
  expect(judge({ mode: "yolo" }, rules, noGrants, "/p", "bash", { command: "ls" })).toEqual({ allow: true });
});

test("a granted command pattern is not asked again; a compound command always is", () => {
  const grants = { project: ["git status*"], global: [], deny: [] };
  expect(judge({ mode: "default" }, [], grants, "/p", "bash", { command: "git status --short" })).toEqual({ allow: true });
  expect("ask" in judge({ mode: "default" }, [], grants, "/p", "bash", { command: "git status && rm x" })).toBe(true);
  const v = judge({ mode: "default" }, [], noGrants, "/p", "bash", { command: "npm test" });
  expect((v as { pattern?: string }).pattern).toBe("npm test*");
});

test("rules match tool and pattern globs, first match wins", () => {
  expect(globMatch("mcp__*", "mcp__github__x")).toBe(true);
  const rules = [
    { tool: "bash", pattern: "git push*", action: "ask" as const },
    { tool: "bash", action: "allow" as const },
  ];
  expect(matchRule(rules, "bash", "git push origin")?.action).toBe("ask");
  expect(matchRule(rules, "bash", "ls")?.action).toBe("allow");
});

// ── the gate, live ────────────────────────────────────────────────────────────

test("an edit waits for approval, and a refusal reaches the model with the user's words", async () => {
  const e = await env();
  e.faux.setResponses([call("write", { path: "notes.md", content: "hello" }), say("ok, I won't")]);
  const run = e.controller.submit("write a note");
  const d = await nextDialog(e.controller);
  if (d.kind !== "approval") throw new Error(`expected approval, got ${d.kind}`);
  expect(d.request.tool).toBe("Write");
  expect(d.request.preview[0]).toEqual({ text: "+ hello", tone: "add" });
  d.resolve({ kind: "no", feedback: "put it in docs/ instead" });
  await run;
  await e.idle();
  expect(fs.existsSync(path.join(e.cwd, "notes.md"))).toBe(false);
  const tool = e.controller.transcript.snapshot().committed.find((b) => b.kind === "tool");
  expect(tool).toMatchObject({ status: "error" });
  expect((tool as { output: string }).output).toContain("put it in docs/ instead");
});

test("'don't ask again' saves the command pattern for this project", async () => {
  const e = await env();
  e.faux.setResponses([call("bash", { command: "echo one" }), call("bash", { command: "echo one more" }), say("done")]);
  const run = e.controller.submit("echo things");
  const d = await nextDialog(e.controller);
  if (d.kind !== "approval") throw new Error("expected approval");
  expect(d.request.always).toBe("echo one*");
  d.resolve({ kind: "always" });
  await run;
  await e.idle();
  const tools = e.controller.transcript.snapshot().committed.filter((b) => b.kind === "tool");
  // The second call matched the grant, so no second dialog was needed.
  expect(tools.map((t) => (t as { output: string }).output.trim())).toEqual(["one", "one more"]);
  const grants = JSON.parse(fs.readFileSync(path.join(e.home, "grants.json"), "utf8"));
  expect(grants.projects[e.cwd]).toEqual(["echo one*"]);
});

test("shift+tab cycles default → accept edits → plan, and the footer says so", async () => {
  const e = await env();
  expect(e.controller.snapshot().footer.mode).toBe("default");
  e.controller.cycleMode();
  expect(e.controller.snapshot().footer.mode).toBe("accept-edits");
  e.controller.cycleMode();
  expect(e.host.mode).toBe("plan");
  e.controller.cycleMode();
  expect(e.host.mode).toBe("default");
});

// ── memory ───────────────────────────────────────────────────────────────────

test("facts are read back from a node's state", () => {
  expect(factsOf("[Entity/Spatial] project x #1\nfacts:\n  - package manager: pnpm\n  - port: 4111\nrecent log:\n  [1] created")).toEqual([
    { key: "package manager", value: "pnpm" },
    { key: "port", value: "4111" },
  ]);
});

memoryTest("what one session learns, the next session knows — and a changed fact replaces the old one", async () => {
  // Session one: the user states a convention; reflection extracts it.
  const one = await env({ memory: true, reflect: true });
  one.faux.setResponses([
    say("Got it — pnpm from now on."),
    fauxAssistantMessage(
      fauxText(
        '{"facts":[{"scope":"project","key":"package manager","value":"pnpm","source":"user"},{"scope":"user","key":"tone","value":"terse answers","source":"user"}]}',
      ),
    ),
  ]);
  await one.controller.submit("in this repo we always use pnpm, never npm");
  await one.idle();
  expect(texts(one.controller).some((t) => t.startsWith("◈ Learned 2 facts"))).toBe(true);
  await one.close();
  envs.splice(envs.indexOf(one), 1);

  // Session two, same home and project: the profile is in the system prompt
  // before the model is asked anything.
  const two = await env({ memory: true, reflect: true, home: one.home, cwd: one.cwd });
  let seen = "";
  const capture: FauxResponseStep = (context) => {
    seen = JSON.stringify(context);
    return say("Run `pnpm install`.");
  };
  two.faux.setResponses([
    capture,
    fauxAssistantMessage(fauxText('{"facts":[{"scope":"project","key":"package manager","value":"bun","source":"user"}]}')),
  ]);
  await two.controller.submit("we moved to bun last week — how do I install the dependencies?");
  await two.idle();
  expect(seen).toContain("package manager: pnpm");
  expect(seen).toContain("tone: terse answers");
  const t = texts(two.controller);
  // The recall line sits right under the message it was for.
  const at = t.findIndex((x) => x === "user: we moved to bun last week — how do I install the dependencies?");
  expect(t[at + 1]).toStartWith("◈ Recalled");

  // The second reflection changed the fact: one current value, not two.
  const profile = await two.memory!.profile("project", `dir:${two.cwd}`);
  expect(profile.filter((f) => f.key === "package manager")).toEqual([{ key: "package manager", value: "bun" }]);
});

memoryTest("a failed tool steers memory, once per distinct failure", async () => {
  const e = await env({ memory: true, mode: "yolo" });
  e.faux.setResponses([call("read", { path: "missing.ts" }), call("read", { path: "missing.ts" }), say("it is not there")]);
  await e.controller.submit("open missing.ts");
  await e.idle();
  const steers = texts(e.controller).filter((t) => t.startsWith("◈ Memory noted"));
  expect(steers.length).toBe(1);
});

memoryTest("/remember and /memory work without the model", async () => {
  const e = await env({ memory: true });
  await e.controller.submit("/remember deploy: fly deploy --remote-only");
  await e.controller.submit("/memory");
  const last = texts(e.controller).at(-1)!;
  expect(last).toContain("deploy: fly deploy --remote-only");
  expect(e.faux.state.callCount).toBe(0);
});

// ── kernel ───────────────────────────────────────────────────────────────────

const pythonTest = (await mnemoEnv()).host.python() ? test : test.skip;

pythonTest("Python state persists between cells, and cells can call Mnemo's tools", async () => {
  const e = await env({ mode: "yolo" });
  e.faux.setResponses([
    call("ipy_run", { code: "x = 20\nx + 22" }),
    call("ipy_run", { code: "x * 2" }),
    call("ipy_run", { code: 'src = tools.read(path="src/fetch.ts")\n"getJson" in src' }),
    say("done"),
  ]);
  await e.controller.submit("compute");
  await e.idle();
  const outputs = e.controller.transcript
    .snapshot()
    .committed.filter((b) => b.kind === "tool" && b.name === "ipy_run")
    .map((b) => (b as { output: string }).output.trim());
  expect(outputs).toEqual(["42", "40", "True"]);
  // The in-kernel read is a real tool call, visible in the transcript.
  expect(e.controller.transcript.snapshot().committed.some((b) => b.kind === "tool" && b.name === "read")).toBe(true);
});

pythonTest("running Python asks first in the default mode", async () => {
  const e = await env();
  e.faux.setResponses([call("ipy_run", { code: "print('hi')" }), say("ok")]);
  const run = e.controller.submit("run it");
  const d = await nextDialog(e.controller);
  expect(d.kind === "approval" && d.request.tool).toBe("Python");
  if (d.kind === "approval") d.resolve({ kind: "yes" });
  await run;
  await e.idle();
});

// ── sub-agents ───────────────────────────────────────────────────────────────

test("a sub-agent works on its own and its answer comes back as the tool result", async () => {
  const e = await env({ mode: "yolo" });
  e.faux.setResponses([
    call("spawn_subagent", { task: "find where JSON is fetched and report the function name" }),
    call("grep", { pattern: "getJson", path: "." }), // the child's turn
    say("The function is getJson in src/fetch.ts."), // the child's answer
    say("The sub-agent found getJson."), // the parent's answer
  ]);
  await e.controller.submit("delegate the search");
  await e.idle();
  const sub = e.controller.transcript.snapshot().committed.find((b) => b.kind === "tool" && b.name === "spawn_subagent");
  expect(sub).toMatchObject({ status: "done" });
  expect((sub as { output: string }).output).toContain("getJson in src/fetch.ts");
});

// ── skills ───────────────────────────────────────────────────────────────────

test("a skill Mnemo writes is a file on disk and loadable after the run", async () => {
  const e = await env({ mode: "yolo" });
  e.faux.setResponses([
    call("create_skill", { name: "release-notes", description: "Write release notes from git log", instructions: "1. git log\n2. group by type" }),
    say("saved"),
  ]);
  await e.controller.submit("remember how we write release notes");
  await e.idle();
  await new Promise((r) => setTimeout(r, 50));
  const file = path.join(e.home, "agent", "skills", "release-notes", "SKILL.md");
  expect(fs.readFileSync(file, "utf8")).toContain("description: \"Write release notes from git log\"");
  expect(e.controller.commands().some((c) => c.name === "skill:release-notes")).toBe(true);
});

test("tool calls are traced, with secrets redacted", async () => {
  const e = await env({ mode: "yolo" });
  e.faux.setResponses([call("bash", { command: "echo sk-ant-abcdefghijklmnopqrstuv" }), say("ok")]);
  await e.controller.submit("echo a key");
  await e.idle();
  const logs = fs.readdirSync(path.join(e.home, "logs"));
  const content = fs.readFileSync(path.join(e.home, "logs", logs[0]!), "utf8");
  expect(content).toContain('"tool":"bash"');
  expect(content).not.toContain("abcdefghijklmnop");
});
