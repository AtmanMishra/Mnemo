/**
 * The session: the thing that turns events into a transcript.
 *
 * It owns the transcript, decides which block each event belongs to, and settles
 * what can settle. It owns no terminal, no model and no clock — a session is
 * driven by events and read by rendering, which is what makes a whole turn
 * testable without a key.
 *
 * The block split follows one rule: **a block is one thing the user is reading.**
 * A user turn, an answer, a tool call. When a tool finishes it stops being a
 * thing to watch and becomes a line of record — so it finalizes, and the
 * transcript is then free to retire it into scrollback.
 */
import { AssistantBlock, wrapLine } from "../transcript/streaming-block.ts";
import { Transcript, type Entry, type TranscriptBlock, type TranscriptRender } from "../transcript/transcript.ts";
import type { SessionEvent } from "./events.ts";
import { promptLines, type ApprovalChoice, type ApprovalPrompt } from "../policy/prompt.ts";

/** Simple finished-or-not block for lines that do not stream. */
class LinesBlock implements TranscriptBlock {
  readonly mode = "mutable" as const;
  #lines: string[];
  #done: boolean;

  constructor(lines: string[], done = true) {
    this.#lines = lines;
    this.#done = done;
  }

  setLines(lines: string[]): void {
    this.#lines = lines;
  }

  finish(): void {
    this.#done = true;
  }

  isFinalized(): boolean {
    return this.#done;
  }

  render(width: number): readonly string[] {
    return this.#lines.flatMap((line) => wrapLine(line, width));
  }
}

/** A tool call: its body while it runs, one line of record once it is done. */
export class ToolBlock extends LinesBlock {
  readonly id: string;
  readonly name: string;

  constructor(event: { id: string; name: string; summary?: string }) {
    super([`▌ ${event.name}${event.summary ? ` — ${event.summary}` : ""} …`], false);
    this.id = event.id;
    this.name = event.name;
  }

  /** One line for the record: what ran and how it went. */
  complete(ok: boolean, summary?: string): void {
    const tail = summary ? ` — ${summary}` : "";
    this.setLines([`▌ ${this.name}${tail}${ok ? "" : "  (failed)"}`]);
    this.finish();
  }
}

export interface SessionOptions {
  /** How many rows the live region may keep before settled blocks retire. */
  keepLive?: number;
}

export class Session {
  readonly transcript = new Transcript();
  #assistant: AssistantBlock | undefined;
  #assistantEntry: Entry | undefined;
  #tools = new Map<string, ToolBlock>();
  /** The question waiting to be answered, if any. */
  #ask: { block: LinesBlock; prompt: ApprovalPrompt } | undefined;
  #keepLive: number;

  constructor(options: SessionOptions = {}) {
    this.#keepLive = options.keepLive ?? 12;
  }

  /** Apply one event. The only way anything enters the transcript. */
  apply(event: SessionEvent): void {
    switch (event.type) {
      case "user":
        this.#assistant = undefined;
        this.#assistantEntry = undefined;
        this.transcript.add(new LinesBlock([`▶ ${event.text}`]));
        break;

      case "ask": {
        // A question is a block like anything else: it appears where the turn
        // reached it and stays there once answered — a record of what was asked
        // and what was decided, not a dialog that vanishes.
        this.#assistant?.finish();
        this.#assistant = undefined;
        this.#assistantEntry = undefined;
        const block = new LinesBlock(promptLines(event.prompt), false);
        this.#ask = { block, prompt: event.prompt };
        this.transcript.add(block);
        break;
      }

      case "assistant-delta": {
        // An answer is one block however many chunks arrive, and a second
        // answer after a tool call is a second block — never one block that
        // silently reopens.
        if (!this.#assistant) {
          this.#assistant = new AssistantBlock();
          this.#assistantEntry = this.transcript.add(this.#assistant);
        }
        this.#assistant.append(event.text);
        break;
      }

      case "assistant-done":
        this.#assistant?.finish();
        break;

      case "tool-start": {
        // A tool call interrupts the answer being written: the paragraph in
        // progress is finished text as far as the transcript is concerned.
        this.#assistant?.finish();
        this.#assistant = undefined;
        this.#assistantEntry = undefined;
        const block = new ToolBlock(event);
        this.#tools.set(event.id, block);
        this.transcript.add(block);
        break;
      }

      case "tool-end": {
        const block = this.#tools.get(event.id);
        block?.complete(event.ok, event.summary);
        this.#tools.delete(event.id);
        break;
      }

      case "notice":
        this.transcript.add(new LinesBlock([`! ${event.text}`]));
        break;

      case "memory":
        // Finished on arrival: the panel reports what memory holds *now*, and a
        // later look is a new answer rather than an update to this one — keeping
        // it live would mean a stale panel redrawn as if it were current.
        this.transcript.add(new LinesBlock(event.lines));
        break;

      case "turn-end":
        this.#assistant?.finish();
        this.#assistant = undefined;
        this.#assistantEntry = undefined;
        this.transcript.settleFinished();
        break;
    }
  }

  /**
   * Render a frame: settle what is finished, retire under pressure, and hand
   * back the history batch plus the live viewport.
   */
  render(width: number): TranscriptRender {
    this.transcript.settleFinished();
    this.transcript.retire(this.#keepLive, width);
    return this.transcript.render(width);
  }

  /** True while an answer is still being written. */
  get streaming(): boolean {
    return this.#assistant !== undefined && !this.#assistant.isFinalized();
  }

  /** A tool that started and has not reported back. */
  get runningTools(): number {
    return this.#tools.size;
  }

  /** The question waiting for an answer, if one is. */
  get awaitingAnswer(): ApprovalPrompt | undefined {
    return this.#ask?.prompt;
  }

  /**
   * Answer the pending question.
   *
   * The block is rewritten to say what was decided and finalized, so the
   * transcript may retire it into scrollback: an answered question is history,
   * and a question left in the live region is a decision nobody can look up.
   */
  answer(choice: ApprovalChoice, note?: string): boolean {
    const pending = this.#ask;
    if (!pending) return false;
    const option = pending.prompt.options.find((candidate) => candidate.id === choice);
    const outcome =
      choice === "other" && note
        ? `you said: ${note}`
        : option
          ? `${option.label} — ${option.effect}`
          : choice;
    pending.block.setLines([`? ${pending.prompt.title}`, `  → ${outcome}`]);
    pending.block.finish();
    this.#ask = undefined;
    return true;
  }
}
