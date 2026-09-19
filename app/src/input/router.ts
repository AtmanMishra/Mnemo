/**
 * One key, one meaning — decided by what is on screen.
 *
 * The reader answers "what key was that?"; this answers "what does it do here?".
 * The interesting cases are all about *who owns the keyboard*:
 *
 *  1. **A question owns it.** While a call is waiting for an answer, a letter is
 *     an answer key, not text for the prompt. Otherwise typing "no thanks" into a
 *     question would silently queue a message instead of refusing the call —
 *     and the reader would believe they had refused it.
 *  2. **"Other" is the exception**, and it is explicit: only then does typing
 *     become a sentence to send back as the answer.
 *  3. **Nothing happens accidentally.** Enter on an empty prompt is not an empty
 *     turn; backspace on an empty prompt is not an error; ctrl+d is only an exit
 *     when there is nothing half-written to lose.
 *  4. **Interrupt outranks everything.** ctrl+c means "stop" wherever it is
 *     pressed, including mid-question — a way out must never depend on the state
 *     it is escaping.
 */
import type { Key } from "./reader.ts";
import { effectOfKey } from "../policy/keys.ts";
import type { ApprovalChoice, ApprovalPrompt } from "../policy/prompt.ts";

/** What the interface is doing right now. */
export interface UiState {
  /** True while the reader is typing an "other" answer rather than a message. */
  answering: boolean;
  /** What has been typed so far. */
  buffer: string;
  /** The question being answered, when one is waiting. */
  question?: ApprovalPrompt;
}

export type Action =
  | { kind: "insert"; text: string }
  | { kind: "backspace" }
  | { kind: "submit"; text: string }
  | { kind: "answer"; choice: ApprovalChoice }
  | { kind: "begin-other" }
  | { kind: "interrupt" }
  | { kind: "exit" }
  | { kind: "none" };

export function route(key: Key, state: UiState): Action {
  // Two ways out, and they work from anywhere.
  if (key.kind === "ctrl" && key.letter === "c") return { kind: "interrupt" };
  if (key.kind === "ctrl" && key.letter === "d" && state.buffer === "" && !state.question) {
    return { kind: "exit" };
  }

  // The name a key is known by: for a typed character that is the character
  // itself, for everything else the kind. Passing `key.kind` for text meant no
  // letter could ever select an answer — `d` and `deny` are the same key, and
  // only one of them is what the reader pressed.
  const name = key.kind === "text" ? key.text : key.kind;

  // A question owns the keyboard: it is checked before anything can be inserted,
  // typed, or pasted into the prompt.
  if (state.question && !state.answering) {
    const effect = effectOfKey(name, state.question);
    if (effect.kind === "answer") return { kind: "answer", choice: effect.choice };
    if (effect.kind === "other") return { kind: "begin-other" };
    // A key that means nothing to the question does nothing — it must not fall
    // through and become text for a message the reader never meant to send.
    return { kind: "none" };
  }

  if (key.kind === "paste") {
    // A pasted page is text wherever text is accepted, and an answer's worth of
    // text while answering — but never a decision.
    return { kind: "insert", text: key.text };
  }

  if (key.kind === "backspace") {
    return state.buffer === "" ? { kind: "none" } : { kind: "backspace" };
  }

  if (key.kind === "enter") {
    if (state.buffer === "" && !state.question) return { kind: "none" };
    if (state.question && !state.answering) {
      // Enter is the affirmative on a question that is not asking for prose.
      const effect = effectOfKey("enter", state.question);
      return effect.kind === "answer" ? { kind: "answer", choice: effect.choice } : { kind: "none" };
    }
    return { kind: "submit", text: state.buffer };
  }

  if (key.kind === "text") return { kind: "insert", text: key.text };
  return { kind: "none" };
}
