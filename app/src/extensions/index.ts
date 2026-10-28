/**
 * Mnemo's behaviour on top of pi: every inline extension, in load order.
 * The policy gate is first so it sees every call before anything else acts.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Host } from "./host.ts";
import { agentsExtension } from "./agents.ts";
import { checkpointsExtension } from "./checkpoints.ts";
import { codeExtension } from "./code.ts";
import { escalateExtension } from "./escalate.ts";
import { finalErrorsExtension } from "./final-errors.ts";
import { hooksExtension } from "./hooks.ts";
import { kernelExtension } from "./kernel.ts";
import { lspExtension } from "./lsp.ts";
import { mcpExtensions } from "./mcp.ts";
import { modelNotesExtension } from "./model-notes.ts";
import { outcomeExtension } from "./outcome.ts";
import { memoryExtension } from "./memory.ts";
import { peersExtension } from "./peers.ts";
import { planExtension } from "./plan.ts";
import { policyExtension } from "./policy.ts";
import { shellExtension } from "./shell.ts";
import { skillsExtension } from "./skills.ts";
import { stateExtension } from "./state.ts";
import { teamExtension } from "./team.ts";
import { marketExtension } from "./market.ts";
import { traceExtension } from "./trace.ts";

export function mnemoExtensions(host: Host): InlineExtension[] {
  return [
    { name: "mnemo-policy", factory: policyExtension(host) },
    // Right after the gate: a hook sees only calls the gate let through, and can still refuse them.
    { name: "mnemo-hooks", factory: hooksExtension(host) },
    // Before memory, which builds on the rendered system prompt that holds plan mode's section.
    { name: "mnemo-plan", factory: planExtension(host) },
    { name: "mnemo-model-notes", factory: modelNotesExtension(host) },
    { name: "mnemo-checkpoints", factory: checkpointsExtension(host) },
    { name: "mnemo-lsp", factory: lspExtension(host) },
    { name: "mnemo-shell", factory: shellExtension(host) },
    { name: "mnemo-memory", factory: memoryExtension(host) },
    // After memory, which says whether a run that ended goes back to verify.
    { name: "mnemo-outcome", factory: outcomeExtension(host) },
    { name: "mnemo-kernel", factory: kernelExtension(host) },
    { name: "mnemo-code", factory: codeExtension(host) },
    { name: "mnemo-agents", factory: agentsExtension(host, mnemoExtensions) },
    { name: "mnemo-peers", factory: peersExtension(host) },
    { name: "mnemo-team", factory: teamExtension(host) },
    // After peers, which sets the root idle when a run ends: the file then says so.
    { name: "mnemo-state", factory: stateExtension(host) },
    { name: "mnemo-skills", factory: skillsExtension(host) },
    { name: "mnemo-market", factory: marketExtension(host) },
    { name: "mnemo-escalate", factory: escalateExtension(host) },
    { name: "mnemo-trace", factory: traceExtension(host) },
    { name: "mnemo-final-errors", factory: finalErrorsExtension() },
    ...mcpExtensions(host),
  ];
}
