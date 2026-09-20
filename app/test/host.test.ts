/**
 * The host's rules, tested by what a reader would see.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session/session.ts";
import { createInterface, type TurnRunner } from "../src/session/host.ts";
import { Composer } from "../src/input/loop.ts";
import { decide, type ToolCall } from "../src/policy/gate.ts";
import { approvalPrompt } from "../src/policy/prompt.ts";

function setup(agent?: TurnRunner) {
  const session = new Session({ keepLive: 0 });
  let redraws = 0;
  let exited = false;
  const iface = createInterface({ session, agent, redraw: () => redraws++, onExit: () => (exited = true) });
  const { host, composer, ask } = iface;
  // Accumulate as the terminal does. A frame's `history` is what has *not yet*
  // been delivered, so reading one frame and calling it "the screen" shows an
  // empty screen for anything an earlier frame already committed. (Fifth time in
  // this suite; the API is right and the reading is the trap.)
  let scrollback: string[] = [];
  const screen = () => {
    const { history, viewport } = session.render(60);
    scrollback = [...scrollback, ...history];
    return [...scrollback, ...viewport].join("\n");
  };
  return { session, host, composer, ask, screen, redraws: () => redraws, exited: () => exited };
}

test("what the reader typed is on screen before the turn starts", () => {
  const seen: string[] = [];
  const agent: TurnRunner = {
    run: () => {
      seen.push(screen());
    },
    interrupt: () => {},
  };
  const { composer, screen } = setup(agent);
  composer.push("refactor the reader\r");
  assert.equal(seen.length, 1, "the turn ran");
  assert.match(seen[0]!, /refactor the reader/, "the message was already on screen when the turn began");
  assert.match(screen(), /refactor the reader/, "and it stays there");
});

test("with no model configured, the reader is told what to do instead of nothing happening", () => {
  const { composer, screen } = setup();
  composer.push("hello\r");
  const text = screen();
  assert.match(text, /hello/, "their message still went through");
  assert.match(text, /\/login/, "and the way forward is named");
  assert.match(text, /\/model/);
});

test("a turn that throws becomes a notice, and the session stays usable", async () => {
  const agent: TurnRunner = {
    run: () => {
      throw new Error("the provider said 401");
    },
    interrupt: () => {},
  };
  const { composer, screen } = setup(agent);
  composer.push("do the thing\r");
  await new Promise((resolve) => setTimeout(resolve, 10));

  const text = screen();
  assert.match(text, /do the thing/);
  assert.match(text, /the turn failed: the provider said 401/, "the reason, kept");
  assert.equal(composer.buffer, "", "the next message can still be typed");
});

test("a turn that rejects asynchronously is also a notice", async () => {
  const agent: TurnRunner = { run: () => Promise.reject(new Error("connection reset")), interrupt: () => {} };
  const { composer, screen } = setup(agent);
  composer.push("try again\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(screen(), /the turn failed: connection reset/);
});

test("interrupting reaches the agent", () => {
  const stops: number[] = [];
  const agent: TurnRunner = { run: () => {}, interrupt: () => stops.push(1) };
  const { composer } = setup(agent);
  composer.push("\x03");
  assert.equal(stops.length, 1, "the agent was told to stop");
});

test("interrupting with nothing running says so rather than nothing", () => {
  const { composer, screen } = setup();
  composer.push("\x03");
  assert.match(screen(), /nothing is running/);
});

test("a question reaches both the screen and the keys, and the answer is recorded", () => {
  const { composer, screen, session, ask } = setup();
  const call: ToolCall = { toolName: "bash", input: { command: "npm test" } };
  ask(approvalPrompt(call, decide(call, { project: [], global: [], deny: [] }))!);

  // Both halves: the screen shows what is being asked, and the keys are the
  // question's. Either alone is a bug — a question nobody can see, or keys that
  // answer something the transcript never recorded.
  assert.match(screen(), /npm test/, "the call is on screen");
  assert.equal(composer.question !== undefined, true, "and the keys belong to it");

  composer.push("d");
  assert.equal(session.awaitingAnswer, undefined, "the question is resolved");
  assert.match(screen(), /→/, `the decision is recorded as a line, not left as a question; screen was:\n${screen()}`);
});

test("exit is the reader's, and only the reader's", () => {
  const { composer, exited } = setup();
  composer.push("\x04");
  assert.equal(exited(), true);
  const busy = setup();
  busy.composer.push("half a thought");
  busy.composer.push("\x04");
  assert.equal(busy.exited(), false);
});

test("every visible change repaints exactly once per change", () => {
  const { composer, redraws } = setup();
  const before = redraws();
  composer.push("abc");
  assert.ok(redraws() > before, "typing is visible");
  const mid = redraws();
  composer.push("\t"); // a tab: nothing here binds it
  assert.equal(redraws(), mid, "a key that did nothing did not repaint");
  composer.push("\x1b[D"); // the caret has somewhere to go now
  assert.equal(redraws(), mid + 1, "and a key that moved it did repaint");
});

test("with a provider configured, the notice does not send you back to /login", () => {
  // The bug this prevents: telling someone who just logged in to log in.
  const session = new Session({ keepLive: 0 });
  let scrollback: string[] = [];
  const iface = createInterface({ session, redraw: () => {}, facts: { home: "C:/home/.mnemo", provider: "openrouter" } });
  const screen = () => {
    const { history, viewport } = session.render(80);
    scrollback = [...scrollback, ...history];
    return [...scrollback, ...viewport].join("\n");
  };

  iface.host.submit("hello");
  const shown = screen();
  assert.doesNotMatch(shown, /\/login to add a provider/, "it does not ask for a step already taken");
  assert.match(shown, /openrouter is configured/, "it says what is actually true");
  assert.match(shown, /\/model/, "and names the step that is actually next");
});

test("with nothing configured, the notice is the first-run one", () => {
  const session = new Session({ keepLive: 0 });
  let scrollback: string[] = [];
  const iface = createInterface({ session, redraw: () => {}, facts: { home: "C:/home/.mnemo" } });
  const screen = () => {
    const { history, viewport } = session.render(80);
    scrollback = [...scrollback, ...history];
    return [...scrollback, ...viewport].join("\n");
  };
  iface.host.submit("hello");
  assert.match(screen(), /\/login to add a provider/, "a fresh machine is told how to start");
});
