/**
 * The agent is told when to use Mnemo's own tools (code index, memory, skills, sub-agents)
 * without being asked, naming only the tools it has; and memory is tidied by itself, at most
 * once a day per project.
 */
import { test, expect, afterEach, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { journalPath, MemoryService, projectIdentity } from "@mnemo/memory";
import { SNIPPETS, workingSection } from "../src/extensions/guide.ts";
import { tidyWhenDue } from "../src/extensions/memory.ts";
import { defaults, SettingsStore } from "../src/runtime/settings.ts";
import { MEMSRV, mnemoEnv, texts } from "./helpers.ts";

setDefaultTimeout(30_000);
const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
const mt = MEMSRV ? test : test.skip;

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
/** Answers, and keeps the system prompt this agent was given. */
const capture = (into: string[], answer: string): FauxResponseStep => (context) => {
  const system = (context as unknown as { messages: { role: string; content: unknown; sections?: unknown }[] }).messages.find((m) => m.role === "system");
  into.push(JSON.stringify(system));
  return say(answer);
};

test("the working section names only the tools that are active", () => {
  expect(workingSection(["read", "bash", "edit", "write"])).toBeUndefined();
  const all = workingSection(Object.keys(SNIPPETS))!;
  for (const tool of ["code_map", "code_search", "code_refs", "memory_search", "memory_steer", "memory_remember", "create_skill", "update_skill", "spawn_subagent"])
    expect(all).toContain(tool);
  // A read-only sub-agent's tools: structure and memory search, nothing that writes memory or skills.
  const readOnly = workingSection(["read", "grep", "find", "ls", "code_search", "code_symbol", "code_refs", "code_map", "memory_search", "spawn_subagent"])!;
  expect(readOnly).toContain("code_search");
  expect(readOnly).toContain("memory_search it");
  expect(readOnly).not.toContain("memory_steer");
  expect(readOnly).not.toContain("memory_remember");
  expect(readOnly).not.toContain("create_skill");
  // create_skill alone (no update_skill) is not enough for the skills line.
  expect(workingSection(["create_skill"])).toBeUndefined();
});

test("on a session, Mnemo's tools are in the tool list and the working section is in the prompt", async () => {
  const e = await mnemoEnv();
  envs.push(e);
  const prompts: string[] = [];
  e.faux.setResponses([capture(prompts, "ok")]);
  await e.controller.submit("hello there");
  await e.idle();
  const p = prompts[0]!;
  expect(p).toContain(`- code_search: ${SNIPPETS.code_search}`);
  expect(p).toContain(`- spawn_subagent: ${SNIPPETS.spawn_subagent}`);
  expect(p).toContain("<working>");
  expect(p).toContain("run code_refs on it");
  // pi's own snippets stay as they were.
  expect(p).toContain("- read: Read file contents");
});

test("with the code index off, nothing points the agent at code tools it does not have", async () => {
  const e = await mnemoEnv({ settings: new SettingsStore({ ...defaults(), codeIndex: false }) });
  envs.push(e);
  const prompts: string[] = [];
  e.faux.setResponses([capture(prompts, "ok")]);
  await e.controller.submit("hello there");
  await e.idle();
  expect(prompts[0]).not.toContain("code_search");
  expect(prompts[0]).not.toContain("code_map");
  expect(prompts[0]).toContain("<working>"); // sub-agents and skills are still there
});

test("a read-only sub-agent is told only about the tools it has", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  const prompts: string[] = [];
  e.faux.setResponses([call("spawn_subagent", { task: "map the modules", name: "mapper" }), capture(prompts, "mapped"), say("done")]);
  await e.controller.submit("map it");
  await e.idle();
  const child = prompts[0]!;
  expect(child).toContain("code_map");
  expect(child).not.toContain("create_skill");
  expect(child).not.toContain("memory_steer");
});

mt("memory is tidied by itself at most once a day per project, and retires what tidy would", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-autotidy-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-autotidy-p-"));
  const mem = new MemoryService(MEMSRV!, journalPath(home));
  try {
    const id = projectIdentity(cwd).id;
    await mem.project(id, projectIdentity(cwd).root);
    await mem.learn("project", id, "test command", "run the tests with bun test --watch");
    await mem.learn("project", id, "tests", "run tests with bun test --watch");
    await mem.learn("project", id, "entry", "the entry point is src/old/main.ts");
    const now = Date.parse("2026-10-28T10:00:00Z");
    const retired = await tidyWhenDue(mem, home, cwd, now);
    expect(retired!.map((t) => t.why).sort()).toEqual(["duplicate", "stale"]);
    expect((await mem.profile("project", id)).map((f) => f.key)).toEqual(["test command"]);
    // Within the day: not due. A day later: due again, and nothing is left to retire.
    await mem.learn("project", id, "again", "run the tests with bun test --watch");
    expect(await tidyWhenDue(mem, home, cwd, now + 60 * 60 * 1000)).toBeUndefined();
    expect((await mem.profile("project", id)).map((f) => f.key).sort()).toEqual(["again", "test command"]);
    expect((await tidyWhenDue(mem, home, cwd, now + 25 * 60 * 60 * 1000))!.length).toBe(1);
  } finally {
    mem.stop();
  }
});

mt("a session start tidies in the background and says what it retired; the setting turns it off", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-autotidy-s-"));
  const seed = async (home: string) => {
    const mem = new MemoryService(MEMSRV!, journalPath(home));
    const id = projectIdentity(cwd).id;
    await mem.project(id, projectIdentity(cwd).root);
    await mem.learn("project", id, "entry", "the entry point is src/old/main.ts");
    mem.stop();
  };
  const on = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-autotidy-on-"));
  await seed(on);
  const e = await mnemoEnv({ memory: true, home: on, cwd });
  envs.push(e);
  await e.idle();
  expect(texts(e.controller).join("\n")).toContain("Tidied memory: retired 1");
  expect((await e.memory!.profile("project", projectIdentity(cwd).id)).length).toBe(0);

  const off = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-autotidy-off-"));
  await seed(off);
  const f = await mnemoEnv({ memory: true, home: off, cwd, settings: new SettingsStore({ ...defaults(), tidyMemory: false }) });
  envs.push(f);
  await f.idle();
  expect(texts(f.controller).join("\n")).not.toContain("Tidied memory");
  expect((await f.memory!.profile("project", projectIdentity(cwd).id)).map((x) => x.key)).toEqual(["entry"]);
});
