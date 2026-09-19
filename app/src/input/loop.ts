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
  /** A secret was typed — a key. It is not a message, and never becomes one. */
  secret(text: string, provider: string): void;
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
  #secret: { provider: string; buffer: string } | undefined;

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

  /** The key prompt's state: which provider, and how much has been typed. */
  get secret(): { provider: string; length: number } | undefined {
    if (!this.#secret) return undefined;
    return { provider: this.#secret.provider, length: this.#secret.buffer.length };
  }

  /**
   * Ask for a key.
   *
   * What is typed next is not echoed, not routed, and not remembered: it goes
   * from the terminal into the host and nowhere else. A key that reached the
   * transcript through any path — a rendered buffer, an echoed command, a
   * history file — would be in scrollback forever.
   */
  enterSecret(provider: string): void {
    this.#secret = { provider, buffer: "" };
    this.#host.changed();
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
    const keys = this.#reader.push(chunk);
    // One key at a time, re-reading the mode each time — because a mode can
    // change *within* a chunk. A terminal hands over whatever was in the pipe:
    // a paste, a script, a fast typist. `/login openrouter\rsk-or-…\r` arrives
    // as a single chunk, and checking the mode once per chunk sent the key
    // straight through the router, where it became a message and was echoed into
    // the transcript. The separator that disables this is a human typing slowly
    // enough to fill several reads, which is not a guarantee worth having.
    for (const key of keys) {
      if (this.#secret) this.#applySecret([key]);
      else this.#apply([key]);
    }
  }

  #applySecret(keys: readonly Key[]): void {
    const secret = this.#secret;
    if (!secret) return;
    let visible = false;

    for (const key of keys) {
      switch (key.kind) {
        case "text":
        case "paste": // pasting a key is the normal way to enter one
          secret.buffer += key.text;
          visible = true;
          break;
        case "backspace":
          secret.buffer = secret.buffer.slice(0, -1);
          visible = true;
          break;
        case "ctrl":
          if (key.letter === "c") {
            this.#secret = undefined;
            this.#host.changed();
            return;
          }
          break;
        case "enter": {
          const { provider, buffer } = secret;
          this.#secret = undefined;
          this.#host.secret(buffer.trim(), provider);
          return;
        }
        default:
          break;
      }
    }
    if (visible) this.#host.changed();
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
