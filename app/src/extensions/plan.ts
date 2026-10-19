/**
 * Plan mode that asks before it plans.
 *
 * In plan mode the gate refuses every change (extensions/policy.ts); this extension tells the
 * model so up front, instead of letting it find out from a refusal, and gives it `ask_user`: a
 * question with optional choices, answered by the user in a dialog. A plan built on a guessed
 * requirement is the plan the user throws away.
 *
 * Only the session the user talks to asks: a sub-agent's question would arrive with no context.
 * With nobody to answer (`mnemo -p`) the tool says so, and the model goes on with its assumption.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Host } from "./host.ts";

export const PLAN_SECTION =
  "Plan mode is on: you can read and search, and every change is refused. When the request leaves a choice that changes the plan " +
  "(scope, an interface, a library, what to keep), ask with ask_user before you plan, one question at a time and only where a guess " +
  "could be wrong. Then give the plan: the files to change, the steps in order and how each will be checked. Do not try to make the change.";

const OTHER = "Something else (type it)";

export function planExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", (event) => {
      if (host.mode === "plan") event.systemPromptOptions.sections.plan = PLAN_SECTION;
    });
    if (host.depth > 0) return;
    pi.registerTool(
      defineTool({
        name: "ask_user",
        label: "Question",
        description:
          "Ask the user a clarifying question and wait for the answer. Use it in plan mode before proposing a plan, or when a request is ambiguous " +
          "in a way that changes what you would do. Offer choices when the answer is one of a few; the user can always type their own.",
        parameters: Type.Object({
          question: Type.String({ description: "One question, in a sentence" }),
          choices: Type.Optional(Type.Array(Type.String(), { description: "Two to six short answers to pick from", maxItems: 6 })),
        }),
        async execute(_id, params, signal, _update, ctx) {
          const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
          if (!ctx.hasUI || !host.ui) return say("Nobody can answer here (a headless run). Go on with your best assumption and state it in your answer.");
          const question = params.question.replace(/\s+/g, " ").trim();
          const choices = (params.choices ?? []).map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean);
          let answer: string | undefined;
          if (choices.length >= 2) {
            answer = await ctx.ui.select(question, [...new Set(choices), OTHER], { signal });
            if (answer === OTHER) answer = await ctx.ui.input(question, "your answer", { signal });
          } else answer = await ctx.ui.input(question, "your answer", { signal });
          answer = answer?.trim();
          return say(answer ? `The user answered: ${answer}` : "The user closed the question without answering. Do not ask it again; go on with your best assumption and say what it was.");
        },
      }),
    );
  };
}
