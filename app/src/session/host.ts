/**
 * The host: what the loop's events mean.
 *
 * The loop says *what happened* — submitted, answered, interrupted, exited — and
 * this decides what to do about it. It is the only place the interface and the
 * agent meet, which is why it is small and why it takes its agent as a parameter
 * rather than importing one.
 *
 * Three rules, each of which is a failure it prevents:
 *
 *  1. **The message appears before the turn starts.** If the turn dies, hangs, or
 *     is interrupted, the reader's own words are still on screen — a prompt that
 *     swallows what you typed when things go wrong makes the transcript lie about
 *     what was asked.
 *  2. **A failed turn is a notice, not a crash.** An error from the runner comes
 *     back as something to read and the session stays usable. Nothing in an
 *     interface should end the reader's session except the reader.
 *  3. **An interrupt with nothing running says so.** Silence would be
 *     indistinguishable from an interrupt that failed to take.
 */
import type { Session } from "./session.ts";
import { Composer, type LoopHost } from "../input/loop.ts";
import type { ApprovalChoice, ApprovalPrompt } from "../policy/prompt.ts";

/** The part of the agent this needs. A test can be a plain object. */
export interface TurnRunner {
  /** Run one turn. Rejections are the host's problem, not the caller's. */
  run(text: string): Promise<void> | void;
  /** Stop a running turn. */
  interrupt(): void;
  /** True while a turn is in flight. */
  readonly running?: boolean;
}

export interface HostOptions {
  session: Session;
  /** Absent when no model is configured — the interface still works. */
  agent?: TurnRunner;
  /** Called after every change, to repaint. */
  redraw(): void;
  /** Called when the reader asked to leave. */
  onExit?: () => void;
}

export function sessionHost(options: HostOptions): LoopHost {
  const { session, agent, redraw, onExit } = options;

  return {
    submit(text: string) {
      // 1: on screen before the turn, so a failure cannot erase the question.
      session.apply({ type: "user", text });
      redraw();

      if (!agent) {
        session.apply({
          type: "notice",
          text: "no model is configured yet — /login to add a provider, then /model to choose one",
          tone: "warn",
        });
        redraw();
        return;
      }

      let outcome: Promise<void> | void;
      try {
        outcome = agent.run(text);
      } catch (error) {
        return report(session, redraw, error);
      }
      Promise.resolve(outcome).catch((error) => report(session, redraw, error));
    },

    answer(choice: ApprovalChoice, note?: string) {
      session.answer(choice, note);
      redraw();
    },

    interrupt() {
      if (!agent) {
        session.apply({ type: "notice", text: "nothing is running", tone: "info" });
        redraw();
        return;
      }
      agent.interrupt();
    },

    exit() {
      onExit?.();
    },

    changed() {
      redraw();
    },
  };
}

/** A turn that failed is something to read, not something to crash on. */
function report(session: Session, redraw: () => void, error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  session.apply({ type: "turn-end" }); // settle whatever the turn left open
  session.apply({ type: "notice", text: `the turn failed: ${text}`, tone: "error" });
  redraw();
}

/** The pieces a running interface needs, wired to each other. */
export interface MnemoInterface {
  host: LoopHost;
  composer: Composer;
  /**
   * A call needs an answer.
   *
   * Two things must happen and neither implies the other: the question has to
   * reach the **session**, so the transcript records what was asked and how it
   * was answered, and it has to reach the **composer**, so keys select an
   * answer instead of typing into the prompt. Doing only the second is how a
   * question becomes invisible — the reader is answering something no screen
   * ever showed them, and afterwards there is no record that it was asked.
   */
  ask(prompt: ApprovalPrompt): void;
}

export function createInterface(options: HostOptions): MnemoInterface {
  const host = sessionHost(options);
  const composer = new Composer(host);
  return {
    host,
    composer,
    ask(prompt: ApprovalPrompt) {
      options.session.apply({ type: "ask", prompt });
      composer.ask(prompt);
      options.redraw();
    },
  };
}
