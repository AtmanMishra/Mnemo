/**
 * The loop: chunks in, state changed, host told what happened.
 *
 * Deliberately not a terminal. It takes chunks and a host, and knows nothing
 * about stdin, raw mode, or escape codes — which is why the whole thing can be
 * tested by feeding it strings, and why the binary that does own a terminal is
 * twenty lines of plumbing instead of the place where behaviour lives.
 *
 * The host is the other half: it is told *what happened* (submitted, answered,
 * interrupted, exit) and decides what that means. This file never runs a turn,
 * calls a model, or touches a screen.
 */
import { KeyReader, type Key } from "./reader.ts";
import { route, type UiState, type Action } from "./router.ts";
import type { ApprovalChoice, ApprovalPrompt } from "../policy/prompt.ts";

export interface LoopHost {
  /** The reader sent a message. */
  submit(text: string): void;
  /** The reader answered a question. `note` is present for an "other" answer. */
  answer(choice: ApprovalChoice, note?: string): void;
  /** ctrl+c. */
  interrupt(): void;
  /** ctrl+d on an empty prompt. */
  exit(): void;
  /** Something visible changed and the screen is now stale. */
  changed(): void;
}

export class Composer {
  readonly #host: LoopHost;
  readonly #reader = new KeyReader();
  #buffer = "";
  #question: ApprovalPrompt | undefined;
  #answering = false;

  constructor(host: LoopHost) {
    this.#host = host;
  }

  /** What the interface is doing, for the prompt and the question to draw. */
  get state(): UiState {
    return { answering: this.#answering, buffer: this.#buffer, question: this.#question };
  }

  get buffer(): string {
    return this.#buffer;
  }

  get question(): ApprovalPrompt | undefined {
    return this.#question;
  }

  /**
   * A call is waiting on the reader.
   *
   * The draft is left untouched: a message half-written when a question arrives
   * is still half-written after it is answered, because losing it would punish
   * the reader for something the agent did.
   */
  ask(question: ApprovalPrompt): void {
    this.#question = question;
    this.#answering = false;
    this.#host.changed();
  }

  /** Feed a chunk from the terminal. */
  push(chunk: string): void {
    this.#apply(this.#reader.push(chunk));
  }

  /** Nothing has arrived for a moment: settle a pending lone Escape. */
  tick(): void {
    if (!this.#reader.incomplete) return;
    this.#apply(this.#reader.flush());
  }

  #apply(keys: readonly Key[]): void {
    let visible = false;
    for (const key of keys) {
      const effect = route(key, this.state);
      if (this.#perform(effect)) visible = true;
    }
    if (visible) this.#host.changed();
  }

  /** Returns true when what is on screen changed. */
  #perform(action: Action): boolean {
    switch (action.kind) {
      case "insert":
        this.#buffer += action.text;
        return true;

      case "backspace":
        this.#buffer = this.#buffer.slice(0, -1);
        return true;

      case "submit": {
        const text = action.text;
        const wasAnswering = this.#answering;
        this.#buffer = "";
        if (wasAnswering) {
          // Writing a reply to a question *is* the answer; the question closes.
          this.#answering = false;
          this.#question = undefined;
          this.#host.answer("other", text);
        } else {
          this.#host.submit(text);
        }
        return true;
      }

      case "answer":
        this.#question = undefined;
        this.#answering = false;
        this.#host.answer(action.choice);
        return true;

      case "begin-other":
        this.#answering = true;
        this.#buffer = "";
        return true;

      case "interrupt":
        this.#host.interrupt();
        // The question survives an interrupt: stopping a turn is not an answer,
        // and the call still needs one.
        return true;

      case "exit":
        this.#host.exit();
        return false;

      case "none":
        return false;
    }
  }
}
