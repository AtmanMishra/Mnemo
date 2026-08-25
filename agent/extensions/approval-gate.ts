/**
 * Approval-gate inline extension: ports src/approval.ts semantics onto pi's
 * tool_call hook.
 *
 * Gate policy (identical to the pre-migration readline gate):
 * - Only bash_exec, write_file, apply_edit are gated.
 * - MNEMO_APPROVAL_MODE=interactive AND stdin is a TTY -> prompt once per call
 *   via ctx.ui.confirm() (native TUI dialog).
 * - Deny blocks the call; the block reason is returned to the model as the
 *   tool result.
 * - Any other mode (unset / 0) or a non-TTY stdin auto-approves: the gate
 *   fails OPEN so piped/automated runs keep working.
 *
 * While this extension is loaded it also flips src/approval.ts into
 * "delegated" mode, so the in-tool readline gate auto-approves instead of
 * asking a second time on the TUI-owned stdin.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { setDelegatedApproval } from "../src/approval.ts";

export const GATED_TOOLS: ReadonlySet<string> = new Set(["bash_exec", "write_file", "apply_edit"]);

/** Minimal shape of the event + UI surface this extension needs (test-friendly). */
export interface ApprovalDecisionInput {
  toolName: string;
  input: Record<string, unknown>;
}
export interface ConfirmUI {
  confirm(title: string, message: string): Promise<boolean>;
}
export interface ApprovalDecision {
  block?: boolean;
  reason?: string;
}

/** One-line summaries, word-for-word identical to the in-tool gate strings. */
export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "bash_exec":
      return `$ ${String((input as any).command ?? "")}`;
    case "write_file": {
      const content = String((input as any).content ?? "");
      const lines = content.length === 0 ? 0 : content.split("\n").length;
      return `write ${lines} lines (${content.length} bytes) to ${String((input as any).path ?? "")}`;
    }
    case "apply_edit":
      return `replace a ${String((input as any).old_str ?? "").length}-char match with ` +
        `${String((input as any).new_str ?? "").length} chars in ${String((input as any).path ?? "")}`;
    default:
      return JSON.stringify(input).slice(0, 120);
  }
}

/**
 * Pure decision function: given the tool-call event, a confirm() UI, env and
 * TTY flag, return {} to allow or { block, reason } to deny.
 */
export async function decideApproval(
  ev: ApprovalDecisionInput,
  ui: ConfirmUI,
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = Boolean(process.stdin.isTTY),
): Promise<ApprovalDecision> {
  if (!GATED_TOOLS.has(ev.toolName)) return {}; // not gated
  if ((env.MNEMO_APPROVAL_MODE ?? env.SEA_APPROVAL_MODE ?? "") !== "interactive") return {}; // mode off
  if (!tty) return {}; // non-TTY: fail open like the old gate

  const summary = summarizeToolCall(ev.toolName, ev.input);
  const ok = await ui.confirm(`Approve ${ev.toolName}?`, summary);
  if (ok) return {};
  return {
    block: true,
    reason: `ERROR: user denied ${ev.toolName}. Action was NOT executed: ${summary}`,
  };
}

/** Factory: delegate the in-tool gate, then prompt via ctx.ui.confirm. */
export function approvalExtensionFactory(pi: ExtensionAPI): void {
  setDelegatedApproval(true);
  pi.on("tool_call", async (event: any, ctx: any) =>
    decideApproval(event as ApprovalDecisionInput, ctx.ui as ConfirmUI),
  );
}

export const approvalExt: InlineExtension = {
  name: "sea-approval",
  factory: approvalExtensionFactory as any,
};

export default approvalExt;
