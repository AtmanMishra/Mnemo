/**
 * The mouse wheel, in the full-screen workspace.
 *
 * A terminal's alternate screen has no scrollback of its own, so by default the
 * wheel either does nothing or is turned into ↑/↓ keys, which recall the draft
 * history in the prompt instead of moving through the conversation. Asking the
 * terminal to report the mouse (button events, SGR encoding) makes the wheel
 * arrive as a sequence we can read, and the transcript can scroll with it.
 *
 * The price of reporting is that the terminal no longer starts a text selection
 * on a plain drag: hold Shift (Option in some terminals) to select, or turn
 * reporting off with `/mouse` or `MNEMO_MOUSE=0`.
 */

const ON = "\x1b[?1000h\x1b[?1006h";
const OFF = "\x1b[?1006l\x1b[?1000l";

/**
 * Wheel notches in a chunk of input, as SGR mouse reports (`ESC [ < button ; x ; y M`).
 * Positive: the wheel rolled up (toward earlier output); negative: down.
 * Clicks, drags and releases are not wheel events and count for nothing.
 */
export function parseWheel(chunk: string): number {
  let notches = 0;
  for (const m of chunk.matchAll(/\x1b\[<(\d+);\d+;\d+M/g)) {
    const button = Number(m[1]);
    // 64 and 65 are the wheel; shift, alt and ctrl add 4, 8 and 16; 32 marks motion.
    if ((button & 0x43) === 0x40) notches += 1;
    else if ((button & 0x43) === 0x41) notches -= 1;
  }
  return notches;
}

/** The reporting switch: one per process, because there is one terminal. */
class Mouse {
  #on = false;
  #stream: { isTTY?: boolean; write(data: string): unknown } = process.stdout;
  #listeners = new Set<() => void>();

  get on(): boolean {
    return this.#on;
  }

  /** Where the escape codes go (tests pass a recorder). */
  attach(stream: { isTTY?: boolean; write(data: string): unknown }): void {
    this.#stream = stream;
  }

  set(on: boolean): void {
    if (on === this.#on || !this.#stream.isTTY) return;
    this.#on = on;
    this.#stream.write(on ? ON : OFF);
    for (const l of this.#listeners) l();
  }

  toggle(): boolean {
    this.set(!this.#on);
    return this.#on;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}

export const mouse = new Mouse();
/** Rows the transcript moves for one notch of the wheel. */
export const WHEEL_ROWS = 3;
