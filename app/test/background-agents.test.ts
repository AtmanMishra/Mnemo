/**
 * Background sub-agents: `spawn_subagent(background: true)` returns at once, the parent goes on,
 * and the sub-agent's answer (or why it failed) comes back as a message from it, within the run's
 * caps. Real pi sessions on the scripted model; each model call is answered by who is asking,
 * since the parent and its background sub-agent call the model at the same time.
 */
import { test, expect, afterEach } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { Roster } from "../src/runtime/roster.ts";
import { mnemoEnv } from "./helpers.ts";

type Env = Awaited<ReturnType<typeof mnemoEnv>>;
const envs: Env[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
async function env(o: Parameters<typeof mnemoEnv>[0] = {}) {
  const e = await mnemoEnv(o);
  envs.push(e);
  return e;
}
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function settle(roster: Roster, e: Env) {
  for (let quiet = 0, i = 0; quiet < 3 && i < 500; i++) {
    await e.idle();
    await tick();
    const busy = e.controller.session.isStreaming || roster.snapshot().nodes.some((n) => n.status === "running");
    quiet = busy ? 0 : quiet + 1;
  }
}
/** Every model call goes to `answer`, with what the caller was sent (as JSON) and whose call it is. */
const route = (e: Env, answer: (sent: string, who: "parent" | "child" | "grandchild", signal?: AbortSignal) => ReturnType<FauxResponseFactory>) => {
  const f: FauxResponseFactory = (context, options) => {
    const sent = JSON.stringify(context);
    const who = sent.includes('"text":"PROMPT') ? "parent" : sent.includes('"text":"GRAND') ? "grandchild" : "child";
    return answer(sent, who, options?.signal);
  };
  e.faux.setResponses(Array.from({ length: 30 }, () => f));
};
const assistantTexts = (e: Env) =>
  e.runtime.session.messages.filter((m) => m.role === "assistant").flatMap((m) => (m as { content: { type: string; text?: string }[] }).content.filter((c) => c.type === "text").map((c) => c.text));
const toolOutput = (e: Env, name: string) => e.controller.transcript.snapshot().committed.filter((b) => b.kind === "tool" && b.name === name) as unknown as { status: string; output: string }[];
const peerMessages = (e: Env) => e.runtime.session.messages.filter((m) => (m as { customType?: string }).customType === "mnemo-peer").map((m) => String((m as { content: unknown }).content));

test("a background sub-agent returns at once, the parent goes on, and its answer comes back as a message", async () => {
  const roster = new Roster();
  const e = await env({ roster, mode: "yolo" });
  let release!: () => void;
  const childMayAnswer = new Promise<void>((r) => (release = r));
  route(e, async (sent, who) => {
    if (who === "child") {
      await childMayAnswer; // it answers only once the parent has finished its own turn
      return say("there are 3 files");
    }
    if (sent.includes("[background result]")) return say("the counter says 3");
    if (sent.includes("in the background")) {
      setTimeout(release, 50);
      return say("started the counter; carrying on");
    }
    return call("spawn_subagent", { task: "count the files", name: "counter", background: true });
  });
  await e.controller.submit("PROMPT count them");
  await settle(roster, e);
  const started = toolOutput(e, "spawn_subagent")[0]!;
  expect(started.status).toBe("done");
  expect(started.output).toMatch(/^Started #\d+ "counter" in the background\. Its answer will reach you as a message from #\d+/);
  expect(started.output).not.toContain("3 files");
  // The parent finished its turn first, then was woken by the answer and used it.
  expect(assistantTexts(e)).toEqual(["started the counter; carrying on", "the counter says 3"]);
  const [peer] = peerMessages(e);
  expect(peer).toContain('[peer message] From agent #2 "counter" (sub-agent (depth 1))');
  expect(peer).toContain("[background result]\n\nthere are 3 files\n\n[ran on mnemo-demo/demo-model");
  const counter = roster.snapshot().nodes.find((n) => n.label === "counter")!;
  expect(counter).toMatchObject({ status: "done", answer: "there are 3 files", run: "r1" });
  // The answer counted as one of the run's messages.
  expect(roster.snapshot().runs.get("r1")!.messages).toBe(1);
});

test("a background sub-agent that fails says why, as a message", async () => {
  const roster = new Roster();
  const e = await env({ roster, mode: "yolo" });
  route(e, (sent, who) => {
    if (who === "child") return fauxAssistantMessage([], { stopReason: "error", errorMessage: "the provider is down" });
    if (sent.includes("[background sub-agent failed")) return say("the counter failed: the provider is down");
    if (sent.includes("in the background")) return say("started");
    return call("spawn_subagent", { task: "count", name: "counter", background: true });
  });
  await e.controller.submit("PROMPT go");
  await settle(roster, e);
  expect(peerMessages(e)[0]).toContain("[background sub-agent failed: the sub-agent's model call failed: the provider is down]");
  expect(assistantTexts(e).at(-1)).toBe("the counter failed: the provider is down");
  expect(roster.snapshot().nodes.find((n) => n.label === "counter")!.status).toBe("failed");
});

test("a sub-agent that finishes stops the background sub-agents it started, which could no longer report to it", async () => {
  const roster = new Roster();
  const e = await env({ roster, mode: "yolo" });
  let grandchildAborted = false;
  let called!: () => void;
  const grandchildWorking = new Promise<void>((r) => (called = r));
  route(e, (sent, who, signal) => {
    if (who === "grandchild")
      // Busy until stopped.
      return new Promise((resolve) => {
        const stop = () => {
          grandchildAborted = true;
          resolve(say("stopped"));
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop);
        called();
      });
    if (who === "child") return sent.includes("in the background") ? grandchildWorking.then(() => say("handed off and done")) : call("spawn_subagent", { task: "GRAND long job", name: "long", background: true });
    return sent.includes('"toolName":"spawn_subagent"') ? say("all done") : call("spawn_subagent", { task: "delegate", name: "middle" });
  });
  await e.controller.submit("PROMPT go");
  await settle(roster, e);
  const [middle, long] = ["middle", "long"].map((l) => roster.snapshot().nodes.find((n) => n.label === l)!);
  expect(middle!.status).toBe("done");
  expect(long!.status).toBe("stopped");
  expect(grandchildAborted).toBe(true);
  // A stopped sub-agent has nothing to report: no message reached the parent that finished.
  expect(roster.snapshot().events.filter((x) => x.kind === "message")).toHaveLength(0);
});

test("without background, spawn_subagent waits for the answer as before", async () => {
  const roster = new Roster();
  const e = await env({ roster, mode: "yolo" });
  route(e, (sent, who) => (who === "child" ? say("42") : sent.includes('"toolName":"spawn_subagent"') ? say("it said 42") : call("spawn_subagent", { task: "answer", name: "oracle" })));
  await e.controller.submit("PROMPT ask");
  await settle(roster, e);
  expect(toolOutput(e, "spawn_subagent")[0]!.output).toStartWith("42\n\n[ran on");
  expect(peerMessages(e)).toEqual([]);
});
