/**
 * Plan mode asks before it plans: the model is told it is in plan mode, and `ask_user`
 * puts its question to the user and brings the answer back.
 */
import { test, expect, afterEach } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { PLAN_SECTION } from "../src/extensions/plan.ts";
import { mnemoEnv, nextDialog } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

const ask = (args: { question: string; choices?: string[] }) => fauxAssistantMessage([fauxToolCall("ask_user", args)], { stopReason: "toolUse" });
const toolResults = (e: Awaited<ReturnType<typeof mnemoEnv>>) =>
  JSON.stringify(e.runtime.session.messages.filter((m) => (m as { role?: string }).role === "toolResult"));

test("in plan mode the model is told so before it tries anything, and not otherwise", async () => {
  const e = await mnemoEnv({ mode: "plan" });
  envs.push(e);
  const prompts: string[] = [];
  const reply = (text: string) => (context: unknown) => {
    prompts.push(JSON.stringify(context));
    return fauxAssistantMessage(fauxText(text));
  };
  e.faux.setResponses([reply("a plan"), reply("done")]);
  await e.controller.submit("refactor the fetch helper");
  await e.idle();
  e.controller.setMode("default");
  await e.controller.submit("now do it");
  await e.idle();
  expect(prompts[0]).toContain(JSON.stringify(PLAN_SECTION).slice(1, -1));
  // pi sends the system prompt as sections and then changes to them: leaving plan mode removes it.
  expect(prompts[1].slice(prompts[1].lastIndexOf('{"role":"system"'))).toContain('"plan":null');
});

test("a question with choices is a pick, and the answer comes back to the model; plan mode does not refuse it", async () => {
  const e = await mnemoEnv({ mode: "plan" });
  envs.push(e);
  e.faux.setResponses([ask({ question: "Keep the old API?", choices: ["yes, deprecate it", "no, remove it"] }), fauxAssistantMessage(fauxText("plan"))]);
  const run = e.controller.submit("plan the change");
  const d = await nextDialog(e.controller);
  if (d.kind !== "select") throw new Error(`expected a pick, got ${d.kind}`);
  expect(d.title).toBe("Keep the old API?");
  expect(d.choices.map((c) => c.value)).toEqual(["yes, deprecate it", "no, remove it", "Something else (type it)"]);
  d.resolve("no, remove it");
  await run;
  await e.idle();
  expect(toolResults(e)).toContain("The user answered: no, remove it");
});

test("'something else' and a question with no choices take typed text; closing it is an answer too", async () => {
  const e = await mnemoEnv({ mode: "plan" });
  envs.push(e);
  e.faux.setResponses([ask({ question: "Which?", choices: ["a", "b"] }), ask({ question: "Why?" }), fauxAssistantMessage(fauxText("plan"))]);
  const run = e.controller.submit("plan");
  const pick = await nextDialog(e.controller);
  if (pick.kind !== "select") throw new Error("expected a pick");
  pick.resolve("Something else (type it)");
  const typed = await nextDialog(e.controller);
  if (typed.kind !== "text") throw new Error(`expected text, got ${typed.kind}`);
  typed.resolve("c, obviously");
  const why = await nextDialog(e.controller);
  if (why.kind !== "text") throw new Error("expected text");
  why.resolve(undefined);
  await run;
  await e.idle();
  const results = toolResults(e);
  expect(results).toContain("The user answered: c, obviously");
  expect(results).toContain("closed the question without answering");
});

test("with nobody to answer, the question says so instead of waiting", async () => {
  const e = await mnemoEnv({ mode: "plan" });
  envs.push(e);
  e.host.ui = undefined;
  e.faux.setResponses([ask({ question: "Which?" }), fauxAssistantMessage(fauxText("plan"))]);
  await e.controller.submit("plan");
  await e.idle();
  expect(toolResults(e)).toContain("Nobody can answer here");
});
