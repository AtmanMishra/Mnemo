/**
 * The redraw protocol, asserted on the bytes.
 *
 * A terminal is a cursor, not a canvas: "up two and clear" is a working screen
 * and "up two" is a screen full of duplicated prompts. The difference is
 * invisible in a frame and obvious in the escape sequence, so it is asserted
 * here rather than looked at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen, attach, type TerminalSurface } from "../src/input/terminal.ts";
import { Session } from "../src/session/session.ts";
import { createInterface, type TurnRunner } from "../src/session/host.ts";

function surface(columns = 60) {
  let written = "";
  const s: TerminalSurface = {
    write: (text) => {
      written += text;
    },
    columns: () => columns,
  };
  return { surface: s, all: () => written, clear: () => (written = "") };
}

test("the first frame is written without moving the cursor", () => {
  const t = surface();
  const screen = new Screen(t.surface);
  const out = screen.draw({ history: [], viewport: ["hello"] });
  assert.equal(out, "hello\n");
  assert.equal(screen.liveRows, 1);
});

test("a frame with nothing in it writes nothing at all", () => {
  const t = surface();
  const screen = new Screen(t.surface);
  const out = screen.draw({ history: [], viewport: [] });
  assert.equal(out, "", "an idle terminal is not repainted into");
  assert.equal(t.all(), "");
});

test("a redraw goes up over the live part and clears it", () => {
  const t = surface();
  const screen = new Screen(t.surface);
  screen.draw({ history: [], viewport: ["one", "two"] });
  t.clear();
  const out = screen.draw({ history: [], viewport: ["one", "TWO"] });
  assert.match(out, /^\x1b\[2A\x1b\[0J/, "up two, then clear downward — not merely up two");
  assert.equal(t.all(), out);
});

test("history is appended above the live part, and only once", () => {
  const t = surface();
  const screen = new Screen(t.surface);
  screen.draw({ history: [], viewport: ["prompt"] });
  t.clear();
  const out = screen.draw({ history: ["● you said hi"], viewport: ["prompt"] });
  assert.equal(out, "\x1b[1A\x1b[0J● you said hi\nprompt\n", "the settled line goes above, the prompt below");

  // The same history must not come back: it is not this layer's business to
  // know what the session has already delivered, but it must not repeat a frame
  // it was handed either.
  t.clear();
  const again = screen.draw({ history: [], viewport: ["prompt"] });
  assert.equal(again, "\x1b[1A\x1b[0Jprompt\n");
});

test("a live part that grows and shrinks clears what it left behind", () => {
  const t = surface();
  const screen = new Screen(t.surface);
  screen.draw({ history: [], viewport: ["a", "b", "c"] });
  t.clear();
  screen.draw({ history: [], viewport: ["a"] });
  assert.match(t.all(), /^\x1b\[3A\x1b\[0J/, "up over all three, even though only one comes back");
  assert.equal(screen.liveRows, 1);
});

test("settle clears the live part once and stops", () => {
  const t = surface();
  const screen = new Screen(t.surface);
  screen.draw({ history: [], viewport: ["prompt"] });
  t.clear();
  assert.equal(screen.settle(), "\x1b[1A\x1b[0J");
  assert.equal(screen.settle(), "", "nothing left to clear");
  assert.equal(screen.liveRows, 0);
});

// ---------------------------------------------------------------------------
// The wire between the terminal and everything else.

function wired(agent?: TurnRunner) {
  const t = surface();
  const session = new Session({ keepLive: 0 });
  let exited = 0;
  const iface = createInterface({ session, agent, redraw: () => frame.repaint(), onExit: () => exited++ });
  const screen = new Screen(t.surface);
  const frame = attach({ iface, session, screen, onExit: () => exited++ });
  frame.repaint();
  t.clear();
  return { t, session, iface, frame, exited: () => exited };
}

test("typing repaints the live part", () => {
  const { t, frame } = wired();
  frame.push("hello");
  const out = t.all();
  assert.match(out, /hello/, "the reader sees what they typed");
  assert.match(out, /^\x1b\[/, "and it was a redraw, not an append");
});

test("submitting moves the message out of the live part", () => {
  const { t, frame, session } = wired({
    run: () => {},
    interrupt: () => {},
  });
  frame.push("do the thing\r");
  assert.match(t.all(), /do the thing/, "on screen");
  const frameNow = session.render(60);
  assert.deepEqual(frameNow.viewport, [], "and nothing is live once the turn is under way");
});

test("exit clears the live part before leaving the terminal", () => {
  const { t, frame, exited } = wired();
  frame.push("half a message");
  t.clear();
  frame.finish();
  assert.equal(exited(), 1);
  assert.match(t.all(), /^\x1b\[\d+A\x1b\[0J/, "the screen is left clean, not mid-prompt");
});

test("the width comes from the terminal, not from a constant", () => {
  const wide = surface(120);
  const session = new Session({ keepLive: 0 });
  const iface = createInterface({ session, redraw: () => {} });
  const screen = new Screen(wide.surface);
  assert.equal(screen.columns(), 120);
  assert.equal(typeof iface.host.submit, "function");
});
