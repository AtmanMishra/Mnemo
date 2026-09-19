/**
 * The real terminal, which is the only part that cannot be tested.
 *
 * Everything interesting already lives elsewhere; this file's whole job is to
 * own the four things that need an operating system: raw mode, the data stream,
 * a timer for a key that arrives alone, and the screen's size. Each is taken as
 * a parameter rather than imported, so the logic is still exercised by a fake —
 * and so this file stays small enough to read in one sitting and verify by eye,
 * which is the only verification available for the parts a test cannot reach.
 *
 * What it deliberately does NOT do: decide anything. It reports bytes to the
 * interface and asks the screen to draw. A terminal adapter that starts making
 * decisions is how behaviour ends up in the one layer that can't be tested.
 */
import { Screen, attach, type TerminalSurface } from "./terminal.ts";
import { createInterface, type MnemoInterface, type TurnRunner } from "../session/host.ts";
import type { Session } from "../session/session.ts";

/** The parts of a terminal this needs, so a test can supply its own. */
export interface TerminalStreams {
  stdin: {
    on(event: "data", listener: (chunk: unknown) => void): void;
    setRawMode?(on: boolean): void;
    resume?(): void;
  };
  stdout: {
    write(text: string): void;
    /** A number, as a real stdout exposes it — not a method. */
    columns?: number;
    rows?: number;
    on?(event: "resize", listener: () => void): void;
    off?(event: "resize", listener: () => void): void;
  };
}

export interface StartOptions {
  streams: TerminalStreams;
  session: Session;
  /** The agent, when one is configured. Absent still gives a working prompt. */
  agent?: TurnRunner;
  /** Leave the process. Injected so a test can watch it happen. */
  exit(code?: number): void;
  /** How long to wait before deciding a lone Escape was the Escape key. */
  settleMs?: number;
}

export interface RunningTui {
  /** Stop owning the terminal. Safe to call more than once. */
  stop(): void;
  /** The wired interface, for callers that need to ask a question or inspect state. */
  iface: MnemoInterface;
}

export function startTui(options: StartOptions): RunningTui {
  const { streams, session, agent, exit, settleMs = 30 } = options;
  const { stdin, stdout } = streams;

  let stopped = false;
  let settle: ReturnType<typeof setInterval> | undefined;

  const surface: TerminalSurface = {
    write: (text) => stdout.write(text),
    // A terminal that will not say how wide it is gets a width that fits an
    // ordinary console, rather than a width that breaks every layout assumption.
    columns: () => stdout.columns ?? 80,
  };
  const screen = new Screen(surface);

  // The interface is built *here* rather than taken as an argument, because it
  // must be wired to this terminal's repaint — and a caller that passes its own
  // gets a prompt that is typed into but never drawn. That mistake is not worth
  // leaving available: making this connection is the entire job of this file, so
  // it makes it, and late-binds the frame to break the circle between the two.
  let frame!: ReturnType<typeof attach>;
  const repaint = () => frame.repaint();
  const iface = createInterface({ session, agent, redraw: repaint, onExit: () => stop(0) });
  frame = attach({ iface, session, screen, onExit: () => stop(0) });

  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume?.();
  stdin.on("data", (chunk) => frame.push(String(chunk)));
  stdout.on?.("resize", repaint);
  repaint();

  // A key that arrives alone is only recognisable by the absence of what would
  // have followed it — so something has to notice the absence.
  //
  // No guard on this: the reader knows whether anything is pending (tick()
  // returns immediately when it is not), and a guard here would skip exactly the
  // case the timer exists for — an Escape pressed at an empty prompt.
  settle = setInterval(() => frame.tick(), settleMs);

  function stop(code?: number): void {
    if (stopped) return;
    stopped = true;
    if (settle !== undefined) clearInterval(settle);
    stdout.off?.("resize", repaint);
    screen.settle();
    if (stdin.setRawMode) stdin.setRawMode(false);
    if (code !== undefined) exit(code);
  }

  return {
    stop: () => stop(undefined),
    iface,
  };
}
