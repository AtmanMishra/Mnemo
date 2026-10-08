/**
 * The experiments measure what they claim. A scripted agent that behaves
 * sensibly — and that uses memory only if memory is in its prompt — runs the
 * real `pitfall-learned` scenario through the real harness: with memory, the
 * second session must apply the remembered fix first and pass; without
 * memory it must rediscover the failure and the same checks must fail.
 */
import { test, expect } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createFaux } from "../src/runtime/demo.ts";
import { runScenario } from "../eval/experiment.ts";
import { SCENARIOS } from "../eval/scenarios.ts";
import type { EvalModel } from "../eval/harness.ts";
import { MEMSRV } from "./helpers.ts";

type Msg = { role: string; content: unknown };
const text = (m: Msg | undefined) => JSON.stringify(m?.content ?? "");

/** A plausible agent for the pitfall scenario, deciding from what it can see. */
const sensibleAgent: FauxResponseStep = (context) => {
  const messages = (context as unknown as { messages: Msg[] }).messages;
  const all = messages.map(text).join("\n");
  const last = messages.at(-1);
  const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
  // The reflection call: name the fix when the run shows one.
  if (text(messages[0]).includes("long-term memory of Mnemo")) {
    // What a model sees: the failure, then the recovery steps the digest lists.
    const fixed = all.includes("run sh scripts/setup.sh first") && all.includes("then: bash(sh scripts/setup.sh)");
    return fauxAssistantMessage(
      fauxText(
        JSON.stringify({
          facts: [],
          fixes: fixed ? [{ problem: "test fixtures missing", fix: "run sh scripts/setup.sh before sh scripts/test.sh" }] : [],
          skill: null,
        }),
      ),
    );
  }
  if (last?.role === "user") {
    // Memory, when present, arrives with the message: follow a known fix first.
    const knowsFix = /pitfall[\s\S]*setup\.sh before/.test(all);
    return bash(knowsFix ? "sh scripts/setup.sh" : "sh scripts/test.sh");
  }
  const out = text(last);
  if (out.includes("run sh scripts/setup.sh first")) return bash("sh scripts/setup.sh");
  if (out.includes("setup complete")) return bash("sh scripts/test.sh");
  return fauxAssistantMessage(fauxText("All 12 tests pass."));
};

async function scripted(agentDir: string): Promise<EvalModel> {
  const { modelRuntime, faux } = await createFaux(agentDir);
  faux.setResponses(Array.from({ length: 200 }, () => sensibleAgent));
  return { modelRuntime, model: faux.getModel(), label: "scripted", faux };
}

const t = MEMSRV ? test : test.skip;
const scenario = SCENARIOS.find((s) => s.name === "pitfall-learned")!;

t("with memory, the remembered fix is applied first and every check passes", async () => {
  const r = await runScenario(scenario, true, 1, scripted);
  expect(r.checks.map((c) => [c.name, c.pass, c.detail])).toEqual(r.checks.map((c) => [c.name, true, undefined]));
  expect(r.sessions[1]!.tools.map((x) => x.args.command)).toEqual(["sh scripts/setup.sh", "sh scripts/test.sh"]);
}, 60_000);

t("without memory, the same agent rediscovers the failure and the behaviour checks fail", async () => {
  const r = await runScenario(scenario, false, 1, scripted);
  expect(r.checks.every((c) => c.kind === "behaviour")).toBe(true);
  expect(r.checks.every((c) => !c.pass)).toBe(true);
  expect(r.sessions[1]!.tools.filter((x) => !x.ok)).toHaveLength(1);
}, 60_000);
