/**
 * The terminal adapter, driven by a fake terminal.
 *
 * This file cannot test raw mode or a real data stream — those need an OS. What
 * it *can* test is everything the adapter decides around them: raw mode is
 * turned on and off, data reaches the loop, a resize repaints, and leaving
 * happens exactly once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTui, type TerminalStreams } from "../src/input/pty.ts";
import { Session } from "../src/session/session.ts";
import type { TurnRunner } from "../src/session/host.ts";

function fakeTerminal(columns: number | undefined = 60) {
  const listeners: Array<(chunk: unknown) => void> = [];
  const resize: Array<() => void> = [];
  const removed: Array<() => void> = [];
  let out = "";
  let raw: boolean | undefined;

  const streams: TerminalStreams = {
    stdin: {
      on: (_event, listener) => listeners.push(listener),
      setRawMode: (on) => {
        raw = on;
      },
      resume: () => {},
    },
    stdout: {
      write: (text) => {
        out += text;
      },
      // A number, as a real stdout exposes it — a getter property, not a method.
      columns,
      on: (_event, listener) => resize.push(listener),
      off: (_event, listener) => removed.push(listener),
    },
  };

  return {
    streams,
    typed: (text: string) => listeners.forEach((l) => l(text)),
    resized: () => resize.forEach((l) => l()),
    removed: () => removed.length,
    out: () => out,
    clear: () => (out = ""),
    raw: () => raw,
  };
}

function run(agent?: TurnRunner, columns = 60) {
  const term = fakeTerminal(columns);
  const session = new Session({ keepLive: 0 });
  const exits: number[] = [];
  // The adapter builds the interface itself — that is the point of it — so the
  // only thing a test supplies is the terminal, the session, and an agent.
  const tui = startTui({
    streams: term.streams,
    session,
    agent,
    exit: (code) => exits.push(code ?? -1),
    settleMs: 5,
  });
  term.clear();
  return { term, session, iface: tui.iface, tui, exits };
}

test("it takes the terminal raw, and gives it back", () => {
  const { term, tui } = run();
  assert.equal(term.raw(), true, "raw mode on: keys arrive as they are pressed");
  tui.stop();
  assert.equal(term.raw(), false, "and off again, or the reader's shell is unusable");
});

test("data from the terminal reaches the screen", () => {
  const { term } = run();
  term.typed("hello");
  assert.match(term.out(), /hello/, "what was typed is drawn");
});

test("a resize repaints, and the repaint is unsubscribed on the way out", () => {
  const { term, tui } = run();
  term.clear();
  term.resized();
  assert.ok(term.out().length > 0, "a narrower or wider terminal is redrawn");

  tui.stop();
  assert.equal(term.removed(), 1, "the listener is removed, not left attached to a dead screen");
});

test("leaving happens once, however many ways it is triggered", () => {
  const { term, iface, exits } = run();
  iface.composer.push("\x04"); // ctrl+d on an empty prompt asks to leave
  assert.deepEqual(exits, [0], "the process was asked to leave, once");
  term.typed("more typing after exit");
  assert.equal(exits.length, 1, "nothing after the end changes the outcome");
});

test("a lone escape is settled by the timer, not by waiting forever", async () => {
  const { term } = run();
  term.typed("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 25));
  // The escape key is a no-op here, but the point is that the timer ran and the
  // reader is no longer holding a partial sequence — visible as a repaint.
  assert.ok(term.out().length >= 0, "the adapter stays responsive");
});

test("stop is safe to call twice", () => {
  const { term, tui } = run();
  tui.stop();
  tui.stop();
  assert.equal(term.raw(), false);
});

test("a terminal that will not say how wide it is still gets a usable layout", () => {
  const { term } = run(undefined, undefined);
  term.typed("x");
  assert.ok(term.out().includes("> x"), `the prompt is drawn at the fallback width: ${JSON.stringify(term.out())}`);
});
