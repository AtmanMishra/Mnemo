/**
 * An assistant answer while it is being written.
 *
 * This is the first real user of the transcript contract, and it is the case the
 * contract exists for: text arrives in pieces, most of it will never change
 * again, and the part that will change is the last line or two. So the finished
 * lines are *stable rows* — they leave for native scrollback as soon as they are
 * finished — and the piece still growing stays in the live viewport.
 *
 * The rule that makes it correct is that a stable row is a **logical** line that
 * is never re-wrapped afterwards. Wrapping happens per logical line, so the
 * physical rows of the first `n` lines are always a prefix of the physical rows
 * of all of them — which is exactly what the contract demands, and exactly what
 * would break if a paragraph already in scrollback could be re-flowed by a later
 * arrival.
 */
import type { StableRow, TranscriptBlock } from "./transcript.ts";

/** Greedy word wrap to `width`, hard-splitting a word that cannot fit. */
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      out.push(line);
      line = word;
    }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  out.push(line);
  return out;
}

export class AssistantBlock implements TranscriptBlock {
  readonly mode = "appendOnly" as const;
  /** Lines that are finished and will never change again. */
  #stable: string[] = [];
  /** The line still being written. */
  #tail = "";
  #done = false;

  /**
   * Take a chunk of the answer. A newline ends a logical line, which is what
   * promotes it to a stable row: the model will not revisit it.
   */
  append(delta: string): void {
    if (this.#done) throw new Error("AssistantBlock: appended after finish()");
    this.#tail += delta;
    const parts = this.#tail.split("\n");
    if (parts.length > 1) {
      this.#tail = parts.pop() ?? "";
      this.#stable.push(...parts);
    }
  }

  /** The answer is complete: the last line becomes stable too. */
  finish(): void {
    if (this.#done) return;
    if (this.#tail.length > 0 || this.#stable.length === 0) this.#stable.push(this.#tail);
    this.#tail = "";
    this.#done = true;
  }

  isFinalized(): boolean {
    return this.#done;
  }

  /** Number of finished logical lines, for tests and for the status row. */
  get stableLineCount(): number {
    return this.#stable.length;
  }

  get text(): string {
    return [...this.#stable, this.#tail].join("\n");
  }

  stableRows(): readonly StableRow[] {
    return this.#stable.map((_, i) => ({ key: `line-${i}` }));
  }

  renderStableRows(count: number, width: number): readonly string[] {
    return this.#stable.slice(0, count).flatMap((line) => wrapLine(line, width));
  }

  render(width: number): readonly string[] {
    const rows = this.#stable.flatMap((line) => wrapLine(line, width));
    if (this.#tail.length > 0) rows.push(...wrapLine(this.#tail, width));
    return rows;
  }
}
