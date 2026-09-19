/**
 * Frames to bytes, and chunks to the loop.
 *
 * A terminal is not a canvas. It is a cursor, and every frame is a decision
 * about where that cursor is and what is above and below it. Getting this wrong
 * is how a terminal interface duplicates lines, eats its own prompt, or scrolls
 * the reader's history away — so the protocol is small, explicit, and returns
 * exactly what it wrote.
 *
 * The layout this keeps: **history scrolls, the viewport is rewritten.** Lines
 * that will never change again are written once and left above; the live part
 * (the prompt, a running answer, a question) is redrawn in place by moving the
 * cursor up over it and clearing. A frame therefore says two things — what to
 * append, what to repaint — and the screen remembers only one number: how many
 * rows the live part currently occupies.
 */
import type { Session } from "../session/session.ts";
import type { MnemoInterface } from "../session/host.ts";
import { keyHints } from "../policy/keys.ts";
import type { UiState } from "./router.ts";

/**
 * The live part the session does not own: the prompt, and what the keys do.
 *
 * The transcript belongs to the session; the prompt belongs to the reader and
 * lives in the composer. Without this the buffer exists only in memory — you
 * type and nothing on screen changes, which is the most alarming thing an
 * interface can do.
 */
export function promptLines(state: UiState): string[] {
  if (state.question && !state.answering) {
    // The question is a block in the transcript; what is live here is the keys.
    return [`  ${keyHints(state.question)}`];
  }
  const marker = state.answering ? "answer> " : "> ";
  return [`${marker}${state.buffer}\u2588`];
}

export interface TerminalSurface {
  write(text: string): void;
  /** The width to lay out for. */
  columns(): number;
}

export class Screen {
  readonly #surface: TerminalSurface;
  #live = 0;

  constructor(surface: TerminalSurface) {
    this.#surface = surface;
  }

  /** How many rows of the screen are the live part. */
  get liveRows(): number {
    return this.#live;
  }

  /** The width to lay out for — the room the interface actually has. */
  columns(): number {
    return this.#surface.columns();
  }

  /**
   * Draw one frame, returning the bytes written.
   *
   * Returned as well as written so a test can assert on the exact escape
   * sequence — the difference between "up two and clear" and "up two" is a
   * screen full of duplicated prompts, and it is invisible without asserting on
   * the bytes.
   */
  draw(frame: { history: readonly string[]; viewport: readonly string[] }): string {
    let out = "";

    // Erase the live part first: up over it, then clear downward.
    if (this.#live > 0) out += `\x1b[${this.#live}A\x1b[0J`;

    // What scrolled: written once, above the live part.
    for (const line of frame.history) out += `${line}\n`;

    // What is live: written now, rewritten next frame.
    for (const line of frame.viewport) out += `${line}\n`;

    this.#live = frame.viewport.length;
    if (out.length > 0) this.#surface.write(out);
    return out;
  }

  /** Clear the live part and leave the cursor where it is, for a clean exit. */
  settle(): string {
    if (this.#live === 0) return "";
    const out = `\x1b[${this.#live}A\x1b[0J`;
    this.#live = 0;
    this.#surface.write(out);
    return out;
  }
}

export interface AttachOptions {
  iface: MnemoInterface;
  session: Session;
  screen: Screen;
  onExit(): void;
}

/**
 * Connect a terminal to the interface.
 *
 * Everything interesting already exists elsewhere: the loop turns chunks into
 * state changes, the host turns events into meaning, the session turns meaning
 * into blocks, and the screen turns a frame into bytes. This is the wire between
 * them, and it is deliberately the stupidest code in the package.
 */
export function attach(options: AttachOptions) {
  const { iface, session, screen, onExit } = options;

  const repaint = () => {
    const frame = session.render(screen.columns());
    screen.draw({
      history: frame.history,
      // The session's live part, then the prompt the reader is typing into.
      viewport: [...frame.viewport, ...promptLines(iface.composer.state)],
    });
  };

  return {
    /** A chunk arrived from the terminal. */
    push(chunk: string): void {
      iface.composer.push(chunk);
    },

    /** Nothing arrived for a moment: settle a pending lone Escape. */
    tick(): void {
      iface.composer.tick();
    },

    repaint,

    /** The reader asked to leave. */
    finish(): void {
      screen.settle();
      onExit();
    },
  };
}
