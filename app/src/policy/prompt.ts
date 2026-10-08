/**
 * The question a call raises, and the answers that may be offered.
 *
 * The gate decides `ask`; this decides what an `ask` looks like and what the
 * reader may choose. Kept separate from the rendering for the same reason the
 * gate is separate from the decision: the *set* of answers is a policy question,
 * and a policy question should be testable without a terminal.
 *
 * The rule that shapes the whole file: **an answer is only offered when it can
 * be kept.**
 *
 *  - A `deny` is not a question, so it offers nothing — showing a menu would
 *    invite the reader to override a rule they are not allowed to override.
 *  - "Always" is offered only when the call generalises to a pattern. A path, or
 *    a command with no shape, has nothing to generalise, and a button that means
 *    "always approve this exact thing" is not a promise anyone can honour later.
 *  - A compound command is never offered "always", because the pattern it would
 *    produce (`ls*`, say) would cover the very commands the generalisation rules
 *    exist to keep separate.
 *  - "Other" is always last and always present: a reader who wants to say
 *    something the menu does not anticipate should have somewhere to say it.
 */
import type { GateResult, ToolCall } from "./gate.ts";

export type ApprovalChoice = "once" | "always-project" | "always-everywhere" | "deny" | "other";

export interface ApprovalOption {
  id: ApprovalChoice;
  /** What the reader sees on the key. */
  label: string;
  /** What choosing it will do, in one line, so the choice is informed. */
  effect: string;
}

export interface ApprovalPrompt {
  /** The call, in the words a reader recognises. */
  title: string;
  /** Why the gate is asking — the gate's own reason, not a rewrite of it. */
  why: string;
  options: ApprovalOption[];
}

/** One line describing a call, for a prompt or a transcript. */
export function describeCall(call: ToolCall): string {
  const command = call.input.command;
  if (typeof command === "string" && command.trim().length > 0) {
    return command.trim().replace(/\s+/g, " ");
  }
  const path = call.input.path ?? call.input.file_path ?? call.input.file;
  if (typeof path === "string" && path.length > 0) return `${call.toolName} ${path}`;
  return call.toolName;
}

/**
 * The prompt for a decision, or null when there is nothing to ask.
 *
 * `allow` and `deny` both answer null: one needs no question, the other refuses
 * to ask one.
 */
export function approvalPrompt(call: ToolCall, result: GateResult): ApprovalPrompt | null {
  if (result.decision !== "ask") return null;
  return {
    title: describeCall(call),
    why: result.reason,
    options: approvalOptions(result),
  };
}

/** The answers offerable for this decision, in the order they are shown. */
export function approvalOptions(result: GateResult): ApprovalOption[] {
  if (result.decision !== "ask") return [];

  const options: ApprovalOption[] = [
    { id: "once", label: "allow once", effect: "run it this time only" },
  ];
  if (result.offerAlways && result.pattern) {
    options.push(
      {
        id: "always-project",
        label: "always, this project",
        effect: `approve ${result.pattern} in this checkout`,
      },
      {
        id: "always-everywhere",
        label: "always, everywhere",
        effect: `approve ${result.pattern} in every project`,
      },
    );
  }
  options.push(
    { id: "deny", label: "don't allow", effect: "leave it unrun" },
    { id: "other", label: "other", effect: "say what should happen instead" },
  );
  return options;
}

/** The prompt as it appears in a transcript: the call, the reason, the answers. */
export function promptLines(prompt: ApprovalPrompt): string[] {
  const lines = [`? ${prompt.title}`, `  ${prompt.why}`];
  for (const option of prompt.options) {
    lines.push(`  [${option.label}] ${option.effect}`);
  }
  return lines;
}
