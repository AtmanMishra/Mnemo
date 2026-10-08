/**
 * Escalation: a cheap model by default, a stronger one only where it fails.
 *
 * In a run, when the project's checks (tests, typecheck, lint, build — the
 * commands memory's verify pattern knows) have failed twice, the rest of the
 * run goes to the stronger model configured (`--escalate provider/id`,
 * `MNEMO_ESCALATE_MODEL`). The session record says it happened, and whatever
 * is learned from then on is attributed to the stronger model, so the cheap
 * one recalls its fix next time. When the run ends the original model comes
 * back. Escalations per run, falling over time, is the measure that memory is
 * doing its job.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERIFY } from "@mnemo/memory";
import type { Host } from "./host.ts";

export const ESCALATE_AFTER = 2;

export function escalateExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const spec = host.escalate;
    if (!spec || host.depth > 0) return;
    let failedChecks = 0;
    let original: Parameters<ExtensionAPI["setModel"]>[0] | undefined;
    const commands = new Map<string, string>();

    pi.on("before_agent_start", async () => {
      failedChecks = 0;
    });

    pi.on("tool_execution_start", async (event) => {
      const args = (event.args ?? {}) as { command?: unknown };
      if (event.toolName === "bash" && typeof args.command === "string") commands.set(event.toolCallId, args.command);
    });

    pi.on("tool_execution_end", async (event, ctx) => {
      const command = commands.get(event.toolCallId);
      commands.delete(event.toolCallId);
      if (!command || !event.isError || !VERIFY.test(command) || original) return;
      failedChecks++;
      if (failedChecks < ESCALATE_AFTER) return;
      const [provider, ...rest] = spec.split("/");
      const strong = host.modelRuntime.getModel(provider!, rest.join("/"));
      if (!strong || !ctx.model || (strong.provider === ctx.model.provider && strong.id === ctx.model.id)) return;
      original = ctx.model;
      if (!(await pi.setModel(strong))) {
        original = undefined;
        host.ui?.note({ kind: "failed", text: `Could not escalate to ${spec}: no credentials for ${provider}` });
        return;
      }
      const reason = `checks failed ${failedChecks} times (${command.slice(0, 60)})`;
      host.ui?.note({ kind: "steer", text: `escalated to ${strong.id} after ${failedChecks} failed checks` });
      host.escalations.push({ from: original.id, to: strong.id, reason });
      await host.onModelChanged?.(strong.id, reason);
    });

    pi.on("agent_end", async () => {
      if (!original) return;
      const back = original;
      original = undefined;
      await pi.setModel(back);
    });
  };
}
