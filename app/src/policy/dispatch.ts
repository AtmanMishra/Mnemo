/**
 * A decision, turned into an action.
 *
 * The gate says `allow` / `ask` / `deny` and the prompt says what may be offered;
 * this is where one of those becomes "it ran" or "it did not", and where the
 * grant an answer earns comes back to be stored. It is the only place that has
 * both the policy and the side effect, so it is the only place that can get the
 * order wrong.
 *
 * The order is the whole design: **nothing runs before the decision is
 * complete.** A "ask the reader and then check again" shape has a window where a
 * call is in flight; this has none, because the runner is not called until the
 * answer is known.
 *
 * Two details that make the answers mean what they say:
 *
 *  - **A grant is returned, not applied.** `always-project` hands back the
 *    pattern instead of writing it, so the caller decides where grants live and
 *    this file stays free of storage, files and the user's home.
 *  - **A refusal carries the reason the reader gave.** When someone types
 *    something instead of choosing, the model is told what they said — otherwise
 *    it tries the same thing again, having been told only "no".
 */
import { decide, type Decision, type Grants, type GateMode, type ToolCall } from "./gate.ts";
import { approvalPrompt, type ApprovalChoice, type ApprovalPrompt } from "./prompt.ts";

export type Ask = (prompt: ApprovalPrompt) => Promise<{ choice: ApprovalChoice; note?: string }>;

export interface GuardedRun {
  /** Whether the call was carried out. */
  ran: boolean;
  decision: Decision;
  /** What the runner returned, when it ran. */
  result?: unknown;
  /** Why it did not run, or why it failed — always something a reader can act on. */
  error?: string;
  /** A grant this answer earned, for the caller to store. */
  grant?: { scope: "project" | "everywhere"; pattern: string };
}

export interface GuardOptions {
  call: ToolCall;
  grants: Grants;
  mode?: GateMode;
  /** The side effect itself. Not called unless the decision allows it. */
  run: () => Promise<unknown>;
  /** Asked only when the gate says `ask`. */
  ask: Ask;
}

export async function guard(options: GuardOptions): Promise<GuardedRun> {
  const { call, grants, run } = options;
  const result = decide(call, grants, options.mode);

  if (result.decision === "deny") {
    return { ran: false, decision: "deny", error: result.reason };
  }
  if (result.decision === "allow") {
    return await perform("allow", run);
  }

  // The question. There is no path from here to `run` that does not go through
  // an answer.
  const prompt = approvalPrompt(call, result);
  if (!prompt) {
    // The gate said ask and the prompt builder produced nothing — a programming
    // error, and refusing is the only safe reading of it.
    return { ran: false, decision: "ask", error: "no prompt could be built for this call" };
  }

  const answer = await options.ask(prompt);
  switch (answer.choice) {
    case "once":
      return await perform("allow", run);

    case "always-project":
    case "always-everywhere": {
      const pattern = result.pattern;
      if (!pattern) {
        // Nothing to generalise: the prompt should not have offered this, and
        // storing a grant here would approve calls the reader never saw.
        return { ran: false, decision: "ask", error: "this call cannot be approved for the future" };
      }
      const performed = await perform("allow", run);
      return {
        ...performed,
        grant: { scope: answer.choice === "always-project" ? "project" : "everywhere", pattern },
      };
    }

    case "deny":
      return { ran: false, decision: "deny", error: "you did not allow this" };

    case "other":
      return {
        ran: false,
        decision: "ask",
        error: answer.note && answer.note.trim().length > 0
          ? `you said: ${answer.note.trim()}`
          : "you answered without saying what should happen instead",
      };
  }
}

/** Run it, and treat a thrown error as a result rather than an escape. */
async function perform(decision: Decision, run: () => Promise<unknown>): Promise<GuardedRun> {
  try {
    return { ran: true, decision, result: await run() };
  } catch (error) {
    // `ran` means the call was carried out, not that it succeeded. Collapsing
    // the two would make "the tool failed" indistinguishable from "the policy
    // refused", which are the two things a reader most needs to tell apart.
    return { ran: true, decision, error: String(error) };
  }
}
