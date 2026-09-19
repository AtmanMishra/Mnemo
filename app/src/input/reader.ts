/**
 * Raw terminal input → keys.
 *
 * A terminal does not deliver keystrokes. It delivers *chunks*, and a chunk is
 * whatever happened to be in the pipe: one key, six keys, half an escape
 * sequence, or a pasted page of text. Everything here exists because of that
 * one fact.
 *
 * The traps, in the order they bite:
 *
 *  1. **An escape sequence can be split across chunks.** Arrow keys arrive as
 *     `\x1b[A`, and there is no guarantee the `\x1b[` and the `A` come together.
 *     A reader that parses per chunk turns one keypress into a stray Escape and
 *     a letter, which is how "my arrow keys type garbage" happens.
 *  2. **A lone Escape is a real key.** It is *also* the first byte of every
 *     sequence, so it can only be recognised after a short wait — `flush()`,
 *     called when nothing follows in time.
 *  3. **Enter arrives as a carriage return**, not the word. The same mistake
 *     that made an approval prompt unanswerable by pressing Enter.
 *  4. **A paste is not typing.** It arrives as one chunk wrapped in bracketed-
 *     paste markers, and delivering it as two hundred separate keys means two
 *     hundred redraws and a rendered mess.
 */
export type Key =
  | { kind: "text"; text: string }
  | { kind: "enter" }
  | { kind: "escape" }
  | { kind: "tab" }
  | { kind: "backspace" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "ctrl"; letter: string }
  | { kind: "paste"; text: string }
  | { kind: "unknown"; raw: string };

const CSI = "\x1b[";
const PASTE_START = `${CSI}200~`;
const PASTE_END = `${CSI}201~`;

/** What the terminal sent for each named sequence we understand. */
const SEQUENCES: Record<string, Key> = {
  A: { kind: "up" },
  B: { kind: "down" },
  C: { kind: "right" },
  D: { kind: "left" },
};

export class KeyReader {
  #pending = "";
  #paste: string | undefined;

  /** True while a partial escape sequence is waiting for the rest of itself. */
  get incomplete(): boolean {
    return this.#pending.length > 0;
  }

  /** Feed a chunk; get back the keys that are complete within it. */
  push(chunk: string): Key[] {
    const keys: Key[] = [];
    this.#pending += chunk;

    for (;;) {
      // Everything consumed: stop, or the next read is of an empty string and
      // the loop dies on `undefined.charCodeAt`.
      if (this.#pending.length === 0) return keys;

      if (this.#paste !== undefined) {
        // Inside a paste: take everything up to the end marker, and hold the
        // rest — the marker itself may be split across chunks.
        const end = this.#pending.indexOf(PASTE_END);
        if (end < 0) return keys;
        this.#paste += this.#pending.slice(0, end);
        keys.push({ kind: "paste", text: this.#paste });
        this.#pending = this.#pending.slice(end + PASTE_END.length);
        this.#paste = undefined;
        continue;
      }

      if (this.#pending.startsWith(PASTE_START)) {
        this.#pending = this.#pending.slice(PASTE_START.length);
        this.#paste = "";
        continue;
      }

      if (this.#pending.startsWith("\x1b")) {
        const key = this.#takeEscape();
        if (!key) return keys;
        keys.push(key);
        continue;
      }

      const char = this.#pending[0]!;
      this.#pending = this.#pending.slice(1);
      const key = named(char);
      if (key) keys.push(key);
    }
  }

  /**
   * Settle whatever is left.
   *
   * Called when nothing has arrived for a moment: at that point a `\x1b` with
   * nothing after it is the Escape key rather than the beginning of a sequence,
   * and anything else is an unrecognised byte that gets reported rather than
   * dropped silently.
   */
  flush(): Key[] {
    if (this.#pending.length === 0) return [];
    const leftover = this.#pending;
    this.#pending = "";
    if (this.#paste !== undefined) {
      // The paste never ended: deliver what arrived rather than losing it.
      this.#paste = undefined;
      return leftover.length > 0 ? [{ kind: "paste", text: leftover }] : [];
    }
    if (leftover === "\x1b") return [{ kind: "escape" }];
    return [{ kind: "unknown", raw: leftover }];
  }

  /** A complete escape sequence, or undefined when the rest has not arrived. */
  #takeEscape(): Key | undefined {
    // Bare Escape: only decidable by timeout, so leave it pending.
    if (this.#pending.length === 1) return undefined;

    if (this.#pending.startsWith(CSI)) {
      // `\x1b[` with nothing after it is still incomplete.
      if (this.#pending.length === CSI.length) return undefined;
      const final = this.#pending[CSI.length]!;
      const sequence = SEQUENCES[final];
      if (sequence) {
        this.#pending = this.#pending.slice(CSI.length + 1);
        return sequence;
      }
      // A modified key (`\x1b[1;5A`) or something we do not model: consume to
      // the first letter and report it, so it cannot be mistaken for text.
      const match = /^\x1b\[[0-9;]*([A-Za-z~])/.exec(this.#pending);
      if (match) {
        this.#pending = this.#pending.slice(match[0].length);
        return { kind: "unknown", raw: match[0] };
      }
      return undefined;
    }

    // `\x1b` followed by something that is not `[` — Alt-key or a stray escape.
    const second = this.#pending[1]!;
    this.#pending = this.#pending.slice(2);
    return { kind: "unknown", raw: `\x1b${second}` };
  }
}

/** One character → the key it is, or undefined when it is ordinary text. */
function named(char: string): Key | undefined {
  switch (char) {
    case "\r":
    case "\n":
      return { kind: "enter" };
    case "\x1b":
      return undefined; // handled above; never reached, kept for clarity
    case "\t":
      return { kind: "tab" };
    case "\x7f":
    case "\b":
      return { kind: "backspace" };
    default: {
      const code = char.charCodeAt(0);
      if (code === 3) return { kind: "ctrl", letter: "c" };
      if (code === 4) return { kind: "ctrl", letter: "d" };
      if (code < 32) return { kind: "unknown", raw: char };
      return { kind: "text", text: char };
    }
  }
}

/** The text of a run of keys, for a prompt that only cares about typing. */
export function textOf(keys: readonly Key[]): string {
  return keys.map((key) => (key.kind === "text" ? key.text : key.kind === "paste" ? key.text : "")).join("");
}
