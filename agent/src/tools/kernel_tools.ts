/**
 * 4.7: the bridge between in-kernel `tools.<name>(...)` calls and the host
 * tool registry.
 *
 * The whole point of this file is that generated code goes through the SAME
 * approval gate and permission rules as a normal tool call. Without it,
 * programmatic tool calling would be a way to run bash_exec without ever
 * showing the user a prompt.
 */
import type { SeaTool, ToolContext } from "./types.ts";
import type { ToolDispatcher } from "./ipy_run.ts";

/** Returns {} to allow, or { block: true, reason } to refuse. */
export type Gate = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ block?: boolean; reason?: string }>;

/** Flatten a ToolResult into the string the program receives. */
export function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/**
 * Build the dispatcher for IPyKernel.setToolDispatcher.
 *
 * A blocked call becomes a ToolError inside the program rather than a silent
 * skip, so the model sees the refusal and can react to it.
 */
export function makeKernelDispatcher(
  tools: readonly SeaTool[],
  gate: Gate,
  callIdPrefix = "kernel",
  /**
   * Context for the tools a cell calls (D6). An in-kernel `bash_exec` has no
   * pi tool-call loop around it, so the kernel supplies the session facts its
   * child shells should publish; undefined is fine.
   */
  context?: () => ToolContext | undefined,
): ToolDispatcher {
  let seq = 0;
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Approval is a user interaction, so it happens ONE AT A TIME even when the
  // calls behind it run in parallel: two readline prompts racing for the same
  // terminal is how you approve the wrong command.
  let gateQueue: Promise<unknown> = Promise.resolve();
  const serializedGate = (name: string, args: Record<string, unknown>) => {
    const run = gateQueue.then(() => gate(name, args), () => gate(name, args));
    gateQueue = run.then(() => undefined, () => undefined);
    return run;
  };
  return async (name, args) => {
    const tool = byName.get(name);
    if (!tool) {
      throw new Error(`unknown tool "${name}". Available: ${[...byName.keys()].sort().join(", ")}`);
    }
    const decision = await serializedGate(name, args ?? {});
    if (decision.block) {
      throw new Error(decision.reason ?? `${name} was blocked`);
    }
    seq += 1;
    const res = await tool.execute(`${callIdPrefix}-${seq}`, args ?? {}, undefined, undefined, context?.());
    return resultText(res as any);
  };
}
