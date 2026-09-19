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
 * turn that ended. Anything richer can be added when a block needs it — the
 * point of a small vocabulary is that adding to it is a deliberate act.
 */
export type SessionEvent =
  | { type: "user"; text: string }
  /** A chunk of the answer as it arrives. */
  | { type: "assistant-delta"; text: string }
  /** The answer is complete; nothing more will be appended to it. */
  | { type: "assistant-done" }
  | { type: "tool-start"; id: string; name: string; summary?: string }
  | { type: "tool-end"; id: string; ok: boolean; summary?: string }
  /** Something the user must read: a warning, a failure, a state change. */
  | { type: "notice"; text: string; tone?: "info" | "warn" | "error" }
  /** The turn is over: everything that can settle, settles. */
  | { type: "turn-end" };

export type SessionEventType = SessionEvent["type"];
