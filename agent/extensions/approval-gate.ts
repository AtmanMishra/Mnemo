/**
 * Approval-gate inline extension: ports src/approval.ts semantics onto pi's
 * tool_call hook.
 *
 * Gate policy:
 * - Gated (mutating) tools: bash_exec, write_file, apply_edit, ipy_run.
 *   ipy_run is gated because a Python cell is full fs/network/process
 *   access — leaving it out would make the bash/write gate bypassable
 *   (audit 0384ee03).
 * - MNEMO_APPROVAL_MODE=interactive is the user's opt-in for prompting. With
 *   it set, a gated call asks once through pi's dialog protocol whenever the
 *   run HAS a dialog-capable UI and blocks unless the user approves: pi's
 *   ctx.hasUI (true in TUI and RPC modes) with ctx.mode === "rpc" as a second
 *   key. It is NOT "stdin is a TTY" — the TUI spawns pi with a pipe, so the
 *   old TTY check made the gate silently fail OPEN in exactly the mode where
 *   a human was waiting (issue #15). In RPC mode the prompt is an
 *   `extension_ui_request` on stdout, answered by the client
 *   (docs/rpc.md §Extension UI Requests).
 * - Every other mode — off, 0, unset — force-approves: the escape hatch for
 *   runs that must not stop for a prompt.
 * - With no UI at all (print / JSON / piped runs) an "ask" still fails OPEN,
 *   so automation keeps working — EXCEPT a sub-agent child
 *   (MNEMO_SUBAGENT_CHILD=1): a delegated child has no operator behind it, so
 *   an "ask" on a mutating tool fails CLOSED (audit b6afa93e). An explicit
 *   allow rule in ~/.mnemo/permissions.json is the way to pre-approve a tool
 *   for children; a deny rule is honored as everywhere else. See
 *   src/permissions.ts for the full policy text.
 * - Deny rules block the call whatever the mode, UI or TTY: the block reason
 *   is returned to the model as the tool result. Plan mode synthesizes deny
 *   rules, so it blocks everywhere too.
 *
 * While this extension is loaded it also flips src/approval.ts into
 * "delegated" mode, so the in-tool readline gate auto-approves instead of
 * asking a second time on the TUI-owned stdin.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { setDelegatedApproval } from "../src/approval.ts";
import { DEFAULT_PERMISSIONS, loadPermissions, resolveAction, type Permissions } from "../src/permissions.ts";
import { isPlanMode, planModeFromEnv, setPlanMode, withPlanMode, PLAN_MODE_REASON } from "../src/plan_mode.ts";

export const GATED_TOOLS: ReadonlySet<string> = new Set([
  "bash_exec",
  "write_file",
  "apply_edit",
  "ipy_run", // 0384ee03: a Python cell is bash wearing a kernel — same gate
]);

/** Set on children spawned by spawn_subagent (see src/tools/subagent.ts). */
export const SUBAGENT_CHILD_ENV = "MNEMO_SUBAGENT_CHILD";

/** True when this process is a delegated sub-agent child (no operator). */
export function isSubagentChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUBAGENT_CHILD_ENV] === "1";
}

/**
 * MNEMO_APPROVAL_MODE=interactive is the user's opt-in for prompting (README).
 * Everything else — "off", "0", unset — force-approves: the escape hatch for
 * runs that must not stop for a prompt. The gate never turns itself on.
 */
export function approvalInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.MNEMO_APPROVAL_MODE ?? env.SEA_APPROVAL_MODE ?? "").trim().toLowerCase();
  return mode === "interactive";
}

/**
 * True when this run has a dialog-capable UI. pi sets ctx.hasUI in TUI and
 * RPC modes (docs/rpc.md: "ctx.mode is \"rpc\" and ctx.hasUI is true ...
 * because the dialog and fire-and-forget methods are functional"); the mode
 * check covers an RPC context from before the flag existed.
 */
export function hasDialogUI(ctx: { hasUI?: boolean; mode?: string } | undefined): boolean {
  if (!ctx) return false;
  return ctx.hasUI === true || ctx.mode === "rpc";
}

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
    case "ipy_run": {
      const code = String((input as any).code ?? "");
      const firstLine = code.split("\n")[0] ?? "";
      return `py> ${firstLine.slice(0, 80)} (${code.length} chars, ${code.split("\n").length} lines)`;
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
 * whether a dialog UI is available, return {} to allow or { block, reason }
 * to deny. `uiAvailable` comes from pi's context (hasDialogUI), never from
 * stdin — see the file header.
 */
export async function decideApproval(
  ev: ApprovalDecisionInput,
  ui: ConfirmUI,
  env: NodeJS.ProcessEnv = process.env,
  uiAvailable: boolean = false,
  // NOT loadPermissions(): a default that reads $HOME would make every test
  // that calls this depend on the developer's real machine state.
  perms: Permissions = DEFAULT_PERMISSIONS,
  plan: boolean = isPlanMode(),
): Promise<ApprovalDecision> {
  perms = withPlanMode(perms, plan);
  // 4.3: rules are consulted for EVERY tool, not just the gated three — a deny
  // rule is the only way to forbid a tool outright.
  const action = resolveAction(perms, ev.toolName, ev.input);
  if (action === "deny") {
    // enforced with or without a UI: a deny that failed open would be theatre
    const summary = summarizeToolCall(ev.toolName, ev.input);
    return {
      block: true,
      reason: plan
        ? `ERROR: ${ev.toolName} was NOT executed: ${PLAN_MODE_REASON}`
        : `ERROR: ${ev.toolName} is denied by ~/.mnemo/permissions.json. ` +
          `Action was NOT executed: ${summary}`,
    };
  }
  if (action === "allow") return {};

  if (!GATED_TOOLS.has(ev.toolName)) return {}; // not gated
  if (!approvalInteractive(env)) return {}; // mode off/0/unset: the force-approve hatch

  if (!uiAvailable) {
    // b6afa93e: a delegated sub-agent child has no UI and no operator to
    // ask. Failing open here let model-authored children run bash/write
    // unprompted while the user trusted the parent's prompts, so an "ask"
    // on a mutating tool fails CLOSED in a child. Deny/allow rules were
    // already resolved above, so an explicit allow rule still passes.
    if (isSubagentChild(env)) {
      const summary = summarizeToolCall(ev.toolName, ev.input);
      return {
        block: true,
        reason:
          `ERROR: ${ev.toolName} is a mutating tool and this non-interactive sub-agent has ` +
          `no operator to approve it. Action was NOT executed: ${summary}. ` +
          `Pre-approve it with an allow rule in ~/.mnemo/permissions.json, ` +
          `or run it in the parent session.`,
      };
    }
    return {}; // no UI (print/JSON/piped parent): fail open like the old gate
  }

  const summary = summarizeToolCall(ev.toolName, ev.input);
  const ok = await ui.confirm(`Approve ${ev.toolName}?`, summary);
  if (ok) return {};
  return {
    block: true,
    reason: `ERROR: user denied ${ev.toolName}. Action was NOT executed: ${summary}`,
  };
}

/**
 * Factory: delegate the in-tool gate, then apply rules + prompt via ctx.ui.
 * `perms` is injectable so tests do not read the developer's own
 * ~/.mnemo/permissions.json.
 */
export function approvalExtensionFactory(pi: ExtensionAPI, perms: Permissions = loadPermissions()): void {
  setDelegatedApproval(true);
  // read once per session: a mid-session edit should not change the rules
  // under a run that is already executing
  setPlanMode(planModeFromEnv());
  pi.on("tool_call", async (event: any, ctx: any) =>
    decideApproval(event as ApprovalDecisionInput, ctx.ui as ConfirmUI,
      process.env, hasDialogUI(ctx), perms),
  );
}

export const approvalExt: InlineExtension = {
  name: "sea-approval",
  factory: approvalExtensionFactory as any,
};

export default approvalExt;
