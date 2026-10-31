/**
 * What a sub-agent is told about where it stands. Its brief arrives as the user's message, so
 * without this it answered as if to a person ("let me know if…"), and a read-only one took pi's
 * preamble ("executing commands, editing code") at its word. The installed binary's pi-docs
 * section is set here too: runtime.ts sets it only in the top-level agent's runtime.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piDocsSection } from "../runtime/runtime.ts";
import type { Host } from "./host.ts";

export function subagentSection(access: Host["access"], parent: number | undefined): string {
  const from = parent === undefined ? "the agent that started you" : `agent #${parent}, which started you`;
  return [
    `You are a sub-agent. The first message is a brief from ${from}, not from the user. Your last message is returned to that agent as your answer, so end with what the brief asks for, complete on its own.`,
    "You cannot ask the user anything: where the brief leaves something open, make the likeliest assumption and say so in your answer.",
    ...(access === "full"
      ? []
      : ["You are read-only: you can read and search, not edit files or run commands. If the task needs a change, describe it in your answer."]),
  ].join("\n");
}

export function roleExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    if (host.depth === 0) return;
    pi.on("before_agent_start", (event) => {
      const o = event.systemPromptOptions;
      const docs = piDocsSection();
      if (docs) o.sections.docs = docs;
      o.sections.subagent = subagentSection(host.access, host.roster.get(host.node)?.parent);
    });
  };
}
