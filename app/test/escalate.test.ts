/**
 * Escalation on a real session: two failed checks in a run move the rest of
 * the run to the stronger model, the move is noted and recorded, and the next
 * run starts on the cheap model again. One failed check, or failures of
 * commands that are not checks, change nothing.
 */
import { test, expect, afterEach } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { mnemoEnv } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

/** Each step records which model answered it. */
function recording(seen: string[], steps: ReturnType<typeof fauxAssistantMessage>[]): FauxResponseStep[] {
  return steps.map((m) => (_c, _o, _s, model) => {
    seen.push(model.id);
    return m;
  });
}
const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));

async function env() {
  const e = await mnemoEnv({ mode: "yolo", escalate: "mnemo-demo/demo-strong" });
  envs.push(e);
  return e;
}

test("two failed checks move the rest of the run to the stronger model, and the next run starts cheap", async () => {
  const e = await env();
  const seen: string[] = [];
  e.faux.setResponses(recording(seen, [bash("npm test --nope; exit 1"), bash("npm test --nope; exit 1"), bash("echo fixed"), say("done")]));
  await e.controller.submit("fix the failing test");
  await e.idle();
  expect(seen).toEqual(["demo-model", "demo-model", "demo-strong", "demo-strong"]);
  expect(e.host.escalations).toHaveLength(1);
  expect(e.host.escalations[0]).toMatchObject({ from: "demo-model", to: "demo-strong" });
  expect(e.controller.session.model?.id).toBe("demo-model");

  e.faux.setResponses(recording(seen, [say("hello")]));
  await e.controller.submit("hi");
  await e.idle();
  expect(seen.at(-1)).toBe("demo-model");
});

test("one failed check, or failing commands that are not checks, do not escalate", async () => {
  const e = await env();
  const seen: string[] = [];
  e.faux.setResponses(recording(seen, [bash("npm test; exit 1"), bash("ls /nonexistent"), bash("cat /nonexistent"), say("done")]));
  await e.controller.submit("look around");
  await e.idle();
  expect(seen.every((m) => m === "demo-model")).toBe(true);
  expect(e.host.escalations).toHaveLength(0);
});
