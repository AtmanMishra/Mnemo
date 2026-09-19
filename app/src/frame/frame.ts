/**
 * One frame of the interface, renderable with no model, no key and no agent.
 *
 * That constraint is what makes the layout checkable: `mnemo --dump` prints this
 * and exits, so a claim about how a first run looks is a command someone else can
 * run rather than a screenshot in a pull request.
 *
 * Three things it has to get right, all of them learned from a real user:
 *
 *  1. **A first run says what to do.** A person installed the old interface, saw
 *     an empty screen, and reported "/login is not working" — about a command
 *     that was working and telling them what to type in a status line that
 *     erased itself after five seconds. Instructions live where they stay.
 *  2. **A working machine is not onboarded.** With a provider and a model the
 *     same frame is a status line. Being taught the basics on every launch is
 *     its own kind of broken.
 *  3. **It fits.** Every line is fitted to the width it was given, because a
 *     renderer that reflows drops a tail without complaining and the terminal
 *     decides the width, not us.
 */
import { renderStatusLine } from "../status/status.ts";

export interface FrameFacts {
  /** e.g. "Bun 1.3.14" — stated, never implied. */
  runtime: string;
  /** The Mnemo home this frame's state came from. */
  home: string;
  /** The provider it will run on, when one is configured. */
  provider?: string;
  model?: string;
  /** Whether the Rust sidecar answered. */
  memory: boolean;
  /** Whether an interpreter for the kernel was found. */
  kernel: boolean;
}

export interface FrameOptions extends FrameFacts {
  rows: number;
  cols: number;
}

/** Fit a line to the columns available, marking what was cut. */
export function fit(text: string, cols: number): string {
  if (cols <= 0) return "";
  if (text.length <= cols) return text;
  return text.slice(0, Math.max(0, cols - 1)) + "…";
}

function pad(text: string, cols: number): string {
  const fitted = fit(text, cols);
  return fitted.length >= cols ? fitted : fitted + " ".repeat(cols - fitted.length);
}

/** `▀▀▐ NAME ▌▀▀▀…▀ ` — a labelled rule that always fills the width. */
export function rule(label: string, cols: number): string {
  const head = `▀▀▐ ${label} ▌`;
  if (head.length >= cols) return fit(head, cols);
  return head + "▀".repeat(cols - head.length);
}

/** `▚ MNEMO ──…── runtime ` — identity on the left, the runtime on the right. */
export function banner(cols: number, runtime: string): string {
  const head = "▚ MNEMO ";
  const tail = ` ${runtime} `;
  if (head.length + tail.length >= cols) return fit(`${head}${tail}`, cols);
  return head + "─".repeat(cols - head.length - tail.length) + tail;
}

/** The numbered path a machine with nothing configured needs. */
export function setupSteps(cols: number): string[] {
  return [
    "  nothing is set up yet — a terminal coding agent whose memory persists",
    "  between sessions, so it does not start from zero every time.",
    "",
    "  1. /login   pick a provider and paste its API key (bare, it lists them)",
    "  2. /model   choose the default model from what that key can run",
    "  3. ask for something — the agent reads, edits and runs commands, asking first",
    "",
  ].map((line) => fit(line, cols));
}

/** The same frame as a status line, once there is something to report. */
export function statusLines(cols: number, facts: FrameFacts): string[] {
  // Built by the status module, not spelled out here: the frame and the status
  // bar show the same machine, and two renderers for one fact is how they start
  // disagreeing.
  return [renderStatusLine(facts, { width: cols, preset: "default", prefix: "  ready. " }), ""];
}

/**
 * Render the frame. Pure: same options in, same string out, no reads of the
 * world — which is why every fact is passed in rather than looked up here.
 */
export function renderFrame(options: FrameOptions): string {
  const { cols } = options;
  const rows: string[] = [];

  rows.push(banner(cols, options.runtime));
  rows.push("");
  rows.push(rule("TRANSCRIPT", cols));
  rows.push(...(options.provider ? statusLines(cols, options) : setupSteps(cols)));

  // On a configured machine the status line above already said all of this; on a
  // fresh one it is the only place the alarm can appear.
  if (!options.provider) {
    rows.push(renderStatusLine(options, { width: cols, preset: "default", prefix: "  " }));
  }
  rows.push(fit(`  home ${options.home}`, cols));

  // Keep the head — identity and instructions — and drop the tail rather than
  // overflowing the height we were given.
  const height = Math.max(1, options.rows - 1);
  return rows.slice(0, height).map((line) => pad(line, cols)).join("\n");
}
