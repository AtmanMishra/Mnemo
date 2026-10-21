/**
 * Hooks around tools and sessions. The hooks are small JavaScript files run with this
 * test's own runtime (`process.execPath`): a `#!/bin/sh` fixture would not run on Windows.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { blockOf, loadHooks, parseHooks, runHook, type Hook, type Hooks } from "../src/extensions/hooks.ts";
import { mnemoEnv } from "./helpers.ts";

const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

/** A hook program: `body` sees the event as `event` and may write to stdout, stderr and exit. */
function script(dir: string, name: string, body: string): string[] {
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(file, `const event = JSON.parse(require("fs").readFileSync(0, "utf8"));\n${body}\n`);
  return [process.execPath, file];
}

function withHooks(home: string, hooks: unknown) {
  fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify({ hooks }));
}

const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
const toolResults = (e: Awaited<ReturnType<typeof mnemoEnv>>) =>
  JSON.stringify(e.runtime.session.messages.filter((m) => (m as { role?: string }).role === "toolResult"));

test("a PreToolUse hook refuses a call with exit 2, and its reason reaches the model", async () => {
  const home = tmp("mnemo-home-");
  withHooks(home, { PreToolUse: [{ matcher: "bash", command: script(home, "guard", `if (event.input.command.includes("curl")) { console.error("no network from here"); process.exit(2) }`) }] });
  const e = await mnemoEnv({ home, mode: "yolo" });
  envs.push(e);
  e.faux.setResponses([bash("curl x"), bash("echo let-through"), fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("go");
  await e.idle();
  const results = toolResults(e);
  expect(results).toContain("A hook refused this call: no network from here");
  // The call the hook let through ran.
  expect(results.split("A hook refused").length).toBe(2);
  expect(results).toContain("let-through");
});

test("a hook can refuse with JSON, and a hook that fails or hangs refuses too", async () => {
  const dir = tmp("mnemo-hooks-");
  const hook = (body: string, timeout?: number) => ({ command: script(dir, `h${Math.random().toString(36).slice(2)}`, body), timeout, source: "test" });
  const ask = async (h: Hook) => blockOf(h, await runHook(h, { tool: "bash" }, dir, dir), true);
  expect(await ask(hook(`console.log(JSON.stringify({ decision: "block", reason: "not on Fridays" }))`))).toBe("not on Fridays");
  expect(await ask(hook(`console.log("all good")`))).toBeUndefined();
  expect(await ask(hook(`process.exit(1)`))).toContain("failed (exit 1)");
  expect(await ask(hook(`setTimeout(() => {}, 60000)`, 0.5))).toContain("did not finish within 0.5s");
  expect(await ask({ command: ["no-such-program-mnemo"], source: "test" })).toContain("is not on PATH");
  // After the call, a failing hook only fails itself.
  expect(blockOf(hook(""), { code: 1, stdout: "", stderr: "" }, false)).toBeUndefined();
}, 20_000);

test("a call the gate refuses never reaches a hook", async () => {
  const home = tmp("mnemo-home-");
  const seen = path.join(home, "SEEN");
  withHooks(home, { PreToolUse: [{ command: script(home, "spy", `require("fs").writeFileSync(${JSON.stringify(seen)}, event.tool)`) }] });
  const e = await mnemoEnv({ home, mode: "plan" });
  envs.push(e);
  e.faux.setResponses([bash("touch x"), fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("go");
  await e.idle();
  expect(fs.existsSync(seen)).toBe(false);
});

test("a PostToolUse hook adds a note to what the model reads, and session hooks see the session", async () => {
  const home = tmp("mnemo-home-");
  const started = path.join(home, "STARTED");
  withHooks(home, {
    PostToolUse: [{ matcher: "bash", command: script(home, "lint", `if (!event.isError) { console.error("remember to run the tests"); process.exit(2) }`) }],
    SessionStart: [{ command: script(home, "start", `require("fs").writeFileSync(${JSON.stringify(started)}, JSON.stringify(event))`) }],
  });
  const e = await mnemoEnv({ home, mode: "yolo" });
  envs.push(e);
  e.faux.setResponses([bash("echo hi"), fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("go");
  await e.idle();
  expect(toolResults(e)).toContain("says: remember to run the tests");
  const start = JSON.parse(fs.readFileSync(started, "utf8"));
  expect(start.event).toBe("SessionStart");
  expect(start.depth).toBe(0);
});

test("the administrator's hooks come first, and a malformed hook is reported, not run", () => {
  const home = tmp("mnemo-home-");
  const managedFile = path.join(home, "managed.json");
  fs.writeFileSync(managedFile, JSON.stringify({ hooks: { PreToolUse: [{ command: "audit" }] } }));
  withHooks(home, { PreToolUse: [{ command: "mine" }, { command: 5 }], Whenever: [] });
  const { hooks, errors } = loadHooks({ home, managedFile });
  expect(hooks.PreToolUse.map((h) => h.command)).toEqual(["audit", "mine"]);
  expect(errors.join("\n")).toContain('needs "command"');
  expect(errors.join("\n")).toContain('unknown hook event "Whenever"');
  const into: Hooks = { PreToolUse: [], PostToolUse: [], SessionStart: [], SessionEnd: [], SubagentStart: [], SubagentStop: [] };
  const errs: string[] = [];
  parseHooks([], "x", into, errs);
  expect(errs).toHaveLength(1);
});

const say = (t: string) => fauxAssistantMessage(fauxText(t));
const spawn = (args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall("spawn_subagent", args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });

test("a SubagentStart hook sees the model and limits and can refuse the sub-agent; SubagentStop sees how it ended", async () => {
  const home = tmp("mnemo-home-");
  const log = path.join(home, "LOG");
  const record = `require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + "\\n");`;
  withHooks(home, {
    SubagentStart: [{ command: script(home, "start", `${record} if (event.name === "forbidden") { console.error("no delegation of that"); process.exit(2) }`) }],
    SubagentStop: [{ command: script(home, "stop", record) }],
  });
  const e = await mnemoEnv({ home, mode: "yolo" });
  envs.push(e);
  e.faux.setResponses([spawn({ task: "look", name: "allowed", maxTurns: 5 }), say("looked"), spawn({ task: "look", name: "forbidden" }), say("done")]);
  await e.controller.submit("delegate twice");
  await e.idle();
  const events = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(events.map((x) => [x.event, x.name])).toEqual([
    ["SubagentStart", "allowed"],
    ["SubagentStop", "allowed"],
    ["SubagentStart", "forbidden"],
  ]);
  expect(events[0]).toMatchObject({ model: "mnemo-demo/demo-model", depth: 1, access: "read-only", caps: { turns: 5 } });
  expect(events[1]).toMatchObject({ status: "done", answer: "looked", turns: 1 });
  // The refused one never started: no node, and the parent read why.
  expect(e.host.roster.snapshot().nodes.filter((n) => n.kind === "sub").map((n) => n.label)).toEqual(["allowed"]);
  expect(toolResults(e)).toContain("A hook refused this sub-agent: no delegation of that");
});

test("a SubagentStart hook that fails refuses the sub-agent, as a check that did not run passed nothing", async () => {
  const home = tmp("mnemo-home-");
  withHooks(home, { SubagentStart: [{ command: script(home, "broken", "process.exit(3)") }] });
  const e = await mnemoEnv({ home, mode: "yolo" });
  envs.push(e);
  e.faux.setResponses([spawn({ task: "look", name: "kid" }), say("could not")]);
  await e.controller.submit("delegate");
  await e.idle();
  expect(e.host.roster.snapshot().nodes.filter((n) => n.kind === "sub")).toHaveLength(0);
  expect(toolResults(e)).toContain("failed (exit 3)");
});
