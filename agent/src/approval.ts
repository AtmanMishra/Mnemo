/**
 * Tool approval gate (Claude Code style).
 *
 * When SEA_APPROVAL_MODE=interactive and stdin is a TTY, every gated action is
 * printed and the user is asked "[y]es / [n]o / [a]lways-this-tool":
 *   y -> proceed once
 *   n -> deny (caller returns an error result to the model)
 *   a -> add the tool to this session's allowlist and proceed
 *
 * Any other mode (including unset, or SEA_APPROVAL_MODE=0) auto-approves, as
 * does a non-TTY stdin (piped/automated runs) -- the gate is best-effort and
 * fails OPEN outside an interactive terminal so automation keeps working.
 *
 * NOTE: this gates THIS process's tool calls only. Child processes spawned by
 * tools (e.g. spawn_subagent) run their own separate sea-agent process; they
 * do NOT share this session's allowlist, and their stdin is typically not a
 * TTY, so they auto-approve. See README.md.
 */
import * as readline from "node:readline";

export interface ApprovalAction {
  tool: string;
  summary: string;
}

/** Injectable I/O so tests can script stdin deterministically. */
export interface ApprovalConfig {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Force interactive prompting even when input lacks an isTTY flag (tests). */
  forceTty: boolean;
}

export const approvalConfig: ApprovalConfig = {
  input: process.stdin,
  output: process.stderr,
  forceTty: false,
};

/**
 * When true, a host-level approver (the pi approval-gate extension using
 * ctx.ui.confirm) owns prompting for this process, so the in-tool readline
 * gate auto-approves instead of asking a second time on the TUI-owned stdin.
 */
let delegated = false;

export function setDelegatedApproval(value: boolean): void {
  delegated = value;
}

export function isDelegatedApproval(): boolean {
  return delegated;
}

const sessionAllowlist = new Set<string>();

/** Clear the per-session allowlist (used by tests). */
export function resetApprovalState(): void {
  sessionAllowlist.clear();
}

/** True when the tool was granted "always allow" earlier this session. */
export function isAlwaysAllowed(tool: string): boolean {
  return sessionAllowlist.has(tool);
}

function interactiveEnabled(): boolean {
  return process.env.SEA_APPROVAL_MODE === "interactive";
}

function isTty(): boolean {
  return approvalConfig.forceTty || Boolean((approvalConfig.input as any)?.isTTY);
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: approvalConfig.input as any,
      output: approvalConfig.output as any,
    });
    let done = false;
    const finish = (value: string) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(value);
    };
    // If the input stream ends (EOF/destroyed) before an answer arrives,
    // resolve empty rather than leaving a permanently pending promise --
    // this is what made the suite hang when a scripted stream ran dry.
    rl.on("close", () => finish(""));
    rl.question(question, (answer) => finish(answer.trim().toLowerCase()));
  });
}

/**
 * Decide whether `action` may proceed. Resolves true (approved) or false
 * (user denied).
 */
export async function approve(action: ApprovalAction): Promise<boolean> {
  if (!interactiveEnabled()) return true; // mode off: current behavior
  if (delegated) return true; // pi extension already prompted via ctx.ui
  if (sessionAllowlist.has(action.tool)) return true; // "always-this-tool"
  if (!isTty()) return true; // non-TTY: fail open (best-effort gate)

  approvalConfig.output.write(`\n[approval] ${action.tool}: ${action.summary}\n`);
  for (;;) {
    const answer = await ask("[y]es / [n]o / [a]lways-this-tool: ");
    if (answer === "y" || answer === "yes") return true;
    if (answer === "a" || answer === "always") {
      sessionAllowlist.add(action.tool);
      return true;
    }
    if (answer === "n" || answer === "no") return false;
    // Unrecognized input: ask again.
  }
}

/**
 * Shared gate for all mutating tool execute() paths. Returns null when the
 * action is approved, or a denial message the caller should return to the
 * model as the tool result.
 */
export async function approvalGate(tool: string, summary: string): Promise<string | null> {
  const ok = await approve({ tool, summary });
  if (ok) return null;
  return `ERROR: user denied ${tool}. Action was NOT executed: ${summary}`;
}
