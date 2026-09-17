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
import * as os from "node:os";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { setDelegatedApproval } from "../src/approval.ts";
import {
  DEFAULT_PERMISSIONS,
  loadPermissions,
  loadScopedPermissions,
  permissionsFile,
  projectPermissionsFile,
  resolveAction,
  subjectOf,
  type Permissions,
} from "../src/permissions.ts";
import { mergeGrantedRules, similarPattern, watchGrants, writeGrant } from "../src/grants.ts";
import { isPlanMode, planModeFromEnv, setPlanMode, withPlanMode, PLAN_MODE_REASON } from "../src/plan_mode.ts";

export const GATED_TOOLS: ReadonlySet<string> = new Set([
  "bash_exec",
  "write_file",
  "apply_edit",
  "ipy_run", // 0384ee03: a Python cell is bash wearing a kernel — same gate
  // #7: a harness bundle is third-party tool code loaded into THIS process
  // with our privileges. The loader validates the manifest; nothing stops the
  // code. Treating the load as a gated call is what makes #7's "in-process
  // with full privileges" a decision the operator makes rather than one we
  // make for them — and in yolo it is answered once, at the top.
  "harness",
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
  /** pi's selector. Absent in older/plain contexts, hence optional. */
  select?(title: string, options: string[], opts?: { timeoutMs?: number }): Promise<string | undefined>;
  /** pi's text dialog, used for the "Other" answer. */
  input?(title: string, placeholder?: string, opts?: { timeoutMs?: number }): Promise<string | undefined>;
  /** Fire and forget; used to tell this session what another one decided. */
  notify?(message: string, level?: string): void;
}

// --- the consent dialog's five answers ------------------------------------
//
// The labels are the contract between this file and the person: the two
// "always" options NAME THE FILE they write, because "always" without a scope
// is how a user ends up with a grant they cannot find. Matching is by prefix
// (pi hands back the string it was given), so the parenthetical detail can
// change without breaking the decision.

export const ALLOW_ONCE = "Allow once";
export const ALLOW_PROJECT = "Allow always in this project";
export const ALLOW_GLOBAL = "Allow always, everywhere";
export const DENY_ONCE = "Don't allow";
export const OTHER = "Other — tell the agent what to do instead";

/** The options for one call. See grants.ts for why "always" can be absent. */
export function consentOptions(tool: string, subject: string): string[] {
  const pattern = similarPattern(tool, subject);
  if (pattern === null) {
    // Many commands, or nothing to generalise: "always" would approve more
    // than the user was shown. Offer the honest three.
    return [ALLOW_ONCE, DENY_ONCE, OTHER];
  }
  return [
    ALLOW_ONCE,
    `${ALLOW_PROJECT} — stores ${pattern} in .mnemo/permissions.json`,
    `${ALLOW_GLOBAL} — stores ${pattern} in ~/.mnemo/permissions.json`,
    DENY_ONCE,
    OTHER,
  ];
}

export type ConsentOutcome =
  | { kind: "once" }
  | { kind: "grant"; scope: "project" | "global"; pattern: string }
  | { kind: "deny" }
  | { kind: "other"; text: string }
  | { kind: "other"; text: null };

/**
 * Read one answer. Split out from decideApproval so the mapping from a chosen
 * label to an outcome is testable without a UI, an event or a file system.
 */
export async function readConsent(
  ui: ConfirmUI,
  toolName: string,
  subject: string,
  input: Record<string, unknown> = {},
): Promise<ConsentOutcome> {
  const options = consentOptions(toolName, subject);
  const pattern = similarPattern(toolName, subject);
  if (!ui.select) {
    // A UI with only confirm() (older contexts, and the in-tool readline gate
    // when it is driving): yes is "once", no is "do not allow". Never a grant —
    // a y/n cannot express a scope, so it must not silently pick one.
    // The summary is the call itself: a prompt that asks about a tool without
    // showing what it would do is a prompt that cannot be answered.
    return (await ui.confirm(`Approve ${toolName}?`, summarizeToolCall(toolName, input)))
      ? { kind: "once" }
      : { kind: "deny" };
  }
  const choice = await ui.select(`Approve ${toolName}?`, options);
  if (choice === undefined) return { kind: "deny" }; // dismissed: unanswered is not consent
  if (choice.startsWith(ALLOW_PROJECT) && pattern) return { kind: "grant", scope: "project", pattern };
  if (choice.startsWith(ALLOW_GLOBAL) && pattern) return { kind: "grant", scope: "global", pattern };
  if (choice.startsWith(ALLOW_ONCE)) return { kind: "once" };
  if (choice.startsWith(DENY_ONCE)) return { kind: "deny" };
  // "Other": the operator writes the answer, so the model is corrected rather
  // than merely stopped. An empty answer is a plain refusal.
  const text = ui.input
    ? (await ui.input("What should the agent do instead?", "e.g. use pnpm, not npm")) ?? null
    : null;
  return { kind: "other", text };
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
  /** Where a project-scoped grant is stored. */
  cwd: string = process.cwd(),
  home?: string,
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

  // YOLO: ask is allow. Checked AFTER deny (above) and after an explicit allow
  // rule, so the mode can only ever relax a prompt — never a prohibition.
  if (perms.yolo) return {};

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
  const outcome = await readConsent(ui, ev.toolName, subjectOf(ev.toolName, ev.input), ev.input);
  if (outcome.kind === "once") return {};
  if (outcome.kind === "grant") {
    const file = writeGrant({ scope: outcome.scope, tool: ev.toolName, pattern: outcome.pattern, cwd, home });
    ui.notify?.(
      file
        ? `allowed ${outcome.pattern} — written to ${file}`
        : `allowed ${outcome.pattern} (already granted)`,
    );
    return {};
  }
  if (outcome.kind === "other" && outcome.text) {
    // The operator's words go back to the model verbatim: a refusal the model
    // cannot act on is a dead end, and the common case is "not like that, do
    // it this way".
    return {
      block: true,
      reason:
        `ERROR: the operator did not approve ${ev.toolName}. Do NOT retry the same call. ` +
        `They said: "${outcome.text}".`,
    };
  }
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
export function approvalExtensionFactory(
  pi: ExtensionAPI,
  perms?: Permissions,
  cwd: string = process.cwd(),
  home?: string,
): void {
  setDelegatedApproval(true);
  // read once per session: a mid-session edit should not change the rules
  // under a run that is already executing
  setPlanMode(planModeFromEnv());

  // Both scopes, project first, with the environment as the last word on yolo.
  let live: Permissions = perms ?? loadScopedPermissions(cwd, home);

  // The UI arrives with the first tool call, so notices are sent from there.
  let ui: ConfirmUI | undefined;
  let announced = false;

  // A grant made in another session is this session's business too: a person
  // who answered "always, everywhere" in one window should not be asked the
  // same question in the next one. The watcher is what makes "all the other
  // sessions get notified" true rather than aspirational — and because the
  // callback re-reads the file, a missed event costs a stale view, never a
  // decision made from one.
  watchGrants(
    [projectPermissionsFile(cwd), permissionsFile(home ?? os.homedir())],
    (changed) => {
      const before = live;
      const fresh = loadScopedPermissions(cwd, home);
      live = {
        ...mergeGrantedRules(before, fresh.rules),
        // yolo may be turned on or off by the file too; a grant that only
        // worked when the file was read at the right moment would be worse
        // than no grant at all.
        yolo: fresh.yolo,
      };
      const added = live.rules.length - before.rules.length;
      if (added > 0) {
        ui?.notify?.(`${added} permission${added === 1 ? "" : "s"} granted in ${changed}`);
      } else if (fresh.yolo !== before.yolo) {
        ui?.notify?.(fresh.yolo ? "yolo is on: prompts are now auto-approved" : "yolo is off");
      }
    },
  );

  pi.on("tool_call", async (event: any, ctx: any) => {
    ui = ctx.ui as ConfirmUI;
    if (!announced) {
      announced = true;
      // A mode that is on must say so: yolo's whole risk is being on without
      // anyone remembering they turned it on.
      if (live.yolo) {
        const denies = live.rules.filter((r) => r.action === "deny").length;
        ui.notify?.(
          denies === 0
            ? "yolo: prompts are auto-approved"
            : `yolo: prompts are auto-approved, but ${denies} deny rule${denies === 1 ? "" : "s"} still hold`,
        );
      }
    }
    return decideApproval(
      event as ApprovalDecisionInput,
      ui,
      process.env,
      hasDialogUI(ctx),
      live,
      isPlanMode(),
      cwd,
      home,
    );
  });
}

export const approvalExt: InlineExtension = {
  name: "sea-approval",
  factory: approvalExtensionFactory as any,
};

export default approvalExt;
