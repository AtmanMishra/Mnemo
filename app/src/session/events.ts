import type { ApprovalPrompt } from "../policy/prompt.ts";

/**
 * The session's event vocabulary.
 *
 * Deliberately *ours*, not pi's. The loop that produces these events is pi's
 * today and may be something else later; what the transcript receives should not
 * change when that happens. Everything from the outside lands here first, gets
 * translated once, and the rest of the application only ever sees this.
 *
 * The shapes are the ones a terminal transcript actually needs to distinguish:
 * text that is still arriving, a tool that is running, a tool that finished, a
 * question waiting to be answered, a turn that ended. Anything richer can be
 * added when a block needs it — the point of a small vocabulary is that adding
 * to it is a deliberate act.
 */
export type SessionEvent =
  | { type: "user"; text: string }
  /**
   * A call the gate would not decide alone. The prompt arrives already built, so
   * the session renders a question without knowing anything about policy.
   */
  | { type: "ask"; prompt: ApprovalPrompt }
  /** A chunk of the answer as it arrives. */
  | { type: "assistant-delta"; text: string }
  /** The answer is complete; nothing more will be appended to it. */
  | { type: "assistant-done" }
  | { type: "tool-start"; id: string; name: string; summary?: string }
  | { type: "tool-end"; id: string; ok: boolean; summary?: string }
  /** Something the user must read: a warning, a failure, a state change. */
  | { type: "notice"; text: string; tone?: "info" | "warn" | "error" }
  /**
   * What memory knows, already formatted. Lines rather than a structure because
   * the only thing the session does with them is draw them — the interpreting
   * happens where the sidecar's answer arrives.
   */
  | { type: "memory"; lines: string[] }
  /**
   * The first thing the interface shows: identity, and the way in.
   *
   * A block rather than chrome, because on an append-only terminal the opening
   * is the top of the transcript and should scroll away like everything else —
   * and because an interface that greets a first run with a bare cursor is the
   * exact failure this rebuild exists to fix.
   */
  | { type: "opening"; lines: string[] }
  /** Lines the interface drew itself: a command's answer, a panel's contents. */
  | { type: "lines"; lines: string[] }
  /** The turn is over: everything that can settle, settles. */
  | { type: "turn-end" };

export type SessionEventType = SessionEvent["type"];
