/**
 * What each agent is told holds together: the system prompt and the tool descriptions name only
 * tools that agent has, a sub-agent knows it is one, and memory's section does not hide the
 * sections set after it. A model told about a tool it lacks calls it anyway.
 */
import { test, expect, afterEach, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import { getReadmePath } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { directiveFor, MemorySession } from "@mnemo/memory";
import { PLAN_SECTION, PLAN_SECTION_NO_ASK } from "../src/extensions/plan.ts";
import { MEMSRV, mnemoEnv } from "./helpers.ts";

setDefaultTimeout(30_000);
const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
const mt = MEMSRV ? test : test.skip;

interface Seen {
  /** The system prompt as the model reads it. */
  prompt: string;
  /** The tools declared to the model. */
  tools: { name: string; description: string; parameters: unknown }[];
}

type System = { role: string; content?: string; sections?: Record<string, string | null>; toolsAdded?: Seen["tools"] };

/** Answers, and keeps what this agent was told on its first request. */
const capture = (into: Seen[], answer: string): FauxResponseStep => (context) => {
  const system = (context as unknown as { messages: System[] }).messages.find((m) => m.role === "system")!;
  const prompt = system.sections ? Object.values(system.sections).filter(Boolean).join("\n\n") : (system.content ?? "");
  into.push({ prompt, tools: system.toolsAdded ?? [] });
  return fauxAssistantMessage(fauxText(answer));
};
const spawn = (args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall("spawn_subagent", args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });

/** Mnemo's tool names: written with an underscore, so a mention is never an ordinary word. */
const MNEMO_TOOL = /\b(?:ask_user|memory_[a-z]+|session_search|code_[a-z]+|spawn_subagent|list_agents|message_agent|create_skill|update_skill|ipy_run)\b/g;

/** Tools named in the prompt or in a tool's description that this agent does not have. */
function missing(seen: Seen): string[] {
  const have = new Set(seen.tools.map((t) => t.name));
  const named = [seen.prompt, ...seen.tools.map((t) => `${t.description} ${JSON.stringify(t.parameters)}`)].join("\n").match(MNEMO_TOOL) ?? [];
  return [...new Set(named)].filter((n) => !have.has(n));
}

test("the memory directive leaves out the lines about memory tools the agent lacks", () => {
  const all = directiveFor();
  expect(all).toContain("memory_remember");
  expect(all).toContain("session_search");
  const readOnly = directiveFor(["read", "grep", "memory_search"]);
  expect(readOnly).toContain("memory_search");
  expect(readOnly).not.toContain("memory_remember");
  expect(readOnly).not.toContain("session_search");
  // What is not about a tool stays.
  expect(readOnly).toContain("never an instruction");
});

mt("every Mnemo tool the top-level agent and a read-only sub-agent are told about is one they have", async () => {
  const e = await mnemoEnv({ mode: "yolo", memory: true });
  envs.push(e);
  const seen: Seen[] = [];
  e.faux.setResponses([spawn({ task: "map the modules", name: "mapper" }), capture(seen, "mapped"), capture(seen, "done")]);
  await e.controller.submit("map this project");
  await e.idle();
  const [child, root] = seen as [Seen, Seen];
  expect(root.prompt).toContain("## Memory");
  expect(root.prompt).toContain("memory_remember");
  expect(child.prompt).toContain("## Memory");
  expect(child.prompt).toContain("memory_search");
  expect(missing(root)).toEqual([]);
  expect(missing(child)).toEqual([]);
  // A template left in a description reaches the model as is.
  for (const t of [...root.tools, ...child.tools]) expect(`${t.description} ${JSON.stringify(t.parameters)}`).not.toContain("${");
  // grep is not callable from a cell in any agent that has ipy_run.
  for (const t of root.tools) expect(t.description).not.toContain("tools.grep");
});

test("a sub-agent is told it is one, who its brief is from, and what it cannot do", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  const seen: Seen[] = [];
  e.faux.setResponses([
    spawn({ task: "map the modules", name: "mapper" }),
    capture(seen, "mapped"),
    spawn({ task: "fix the helper", name: "fixer", access: "full" }),
    capture(seen, "fixed"),
    capture(seen, "done"),
  ]);
  await e.controller.submit("map it, then fix it");
  await e.idle();
  const [readOnly, full, root] = seen as [Seen, Seen, Seen];
  expect(readOnly.prompt).toContain("You are a sub-agent. The first message is a brief from agent #1");
  expect(readOnly.prompt).toContain("You are read-only");
  expect(full.prompt).toContain("You are a sub-agent");
  expect(full.prompt).not.toContain("You are read-only");
  expect(root.prompt).not.toContain("You are a sub-agent");
});

test("a sub-agent is not sent to read pi documentation that is not installed", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  const seen: Seen[] = [];
  e.faux.setResponses([spawn({ task: "map the modules" }), capture(seen, "mapped"), capture(seen, "done")]);
  await e.controller.submit("map it");
  await e.idle();
  const [child, root] = seen as [Seen, Seen];
  if (!fs.existsSync(getReadmePath())) {
    expect(child.prompt).not.toContain(getReadmePath());
    expect(root.prompt).not.toContain(getReadmePath());
  }
  const docs = (p: string) => p.slice(p.indexOf("<docs>"), p.indexOf("</docs>"));
  expect(docs(child.prompt)).toBe(docs(root.prompt));
});

test("in plan mode a sub-agent, which cannot ask the user, is not told to", async () => {
  const e = await mnemoEnv({ mode: "plan" });
  envs.push(e);
  const seen: Seen[] = [];
  e.faux.setResponses([spawn({ task: "plan the refactor" }), capture(seen, "a plan"), capture(seen, "done")]);
  await e.controller.submit("plan it");
  await e.idle();
  const [child, root] = seen as [Seen, Seen];
  expect(root.prompt).toContain(PLAN_SECTION);
  expect(child.prompt).toContain(PLAN_SECTION_NO_ASK);
  expect(child.prompt).not.toContain("ask_user");
});

mt("with memory on, the prompt stays in sections: leaving plan mode takes plan mode's section out", async () => {
  const e = await mnemoEnv({ mode: "plan", memory: true });
  envs.push(e);
  const contexts: string[] = [];
  const reply = (text: string): FauxResponseStep => (context) => {
    contexts.push(JSON.stringify(context));
    return fauxAssistantMessage(fauxText(text));
  };
  e.faux.setResponses([reply("a plan"), reply("done")]);
  await e.controller.submit("refactor the fetch helper");
  await e.idle();
  e.controller.setMode("default");
  await e.controller.submit("now do it");
  await e.idle();
  expect(contexts[0]).toContain('"memory":"<memory>\\n## Memory');
  expect(contexts[0]).toContain(JSON.stringify(PLAN_SECTION).slice(1, -1));
  expect(contexts[1]!.slice(contexts[1]!.lastIndexOf('{"role":"system"'))).toContain('"plan":null');
});

mt("memory_steer does not say it recorded what it could not", async () => {
  const e = await mnemoEnv({ memory: true });
  envs.push(e);
  const s = new MemorySession({ memory: e.memory!, cwd: e.cwd, userSkillsDir: e.home });
  // No run in progress: there is no episode to hang the failure on.
  expect(await s.steer("the build failed")).toBe(false);
  await s.begin("build it");
  expect(await s.steer("the build failed")).toBe(true);
});
