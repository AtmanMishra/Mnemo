/**
 * Mnemo's behaviour on top of pi: every inline extension, in load order.
 * The policy gate is first so it sees every call before anything else acts.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Host } from "./host.ts";
import { agentsExtension } from "./agents.ts";
import { escalateExtension } from "./escalate.ts";
import { kernelExtension } from "./kernel.ts";
import { memoryExtension } from "./memory.ts";
import { policyExtension } from "./policy.ts";
import { skillsExtension } from "./skills.ts";
import { traceExtension } from "./trace.ts";

export function mnemoExtensions(host: Host): InlineExtension[] {
  return [
    { name: "mnemo-policy", factory: policyExtension(host) },
    { name: "mnemo-memory", factory: memoryExtension(host) },
    { name: "mnemo-kernel", factory: kernelExtension(host) },
    { name: "mnemo-agents", factory: agentsExtension(host, mnemoExtensions) },
    { name: "mnemo-skills", factory: skillsExtension(host) },
    { name: "mnemo-escalate", factory: escalateExtension(host) },
    { name: "mnemo-trace", factory: traceExtension(host) },
  ];
}
