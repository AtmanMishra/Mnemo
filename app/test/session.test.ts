/**
 * A session, driven by a scripted set of events.
 *
 * No model, no key, no clock: a turn is a list of events, and what a terminal
 * shows after them is a value. That is the whole reason the event vocabulary and
 * the session are separate from anything that spawns a process.
 *
 * The assertions are about what the user ends up reading, not about internal
 * state — every one of these could be checked by looking at the screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session/session.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { decide, type ToolCall } from "../src/policy/gate.ts";
import { approvalPrompt } from "../src/policy/prompt.ts";

/** Apply events, rendering after each, and keep what the screen showed. */
function play(events: SessionEvent[], width: number, keepLive = 12) {
  const session = new Session({ keepLive });
  const scrollback: string[] = [];
  const frames: { history: readonly string[]; viewport: readonly string[] }[] = [];

  for (const event of events) {
    session.apply(event);
    const frame = session.render(width);
    scrollback.push(...frame.history);
    frames.push({ history: [...frame.history], viewport: [...frame.viewport] });
  }
  /**
   * What the terminal is showing now: everything that has ever scrolled past,
   * plus the live region as it stands. A frame's own `history` is a *delta*, so
   * asserting on one frame proves nothing about the screen.
   */
  const onScreen = () => [...scrollback, ...(frames.at(-1)?.viewport ?? [])];
  return { session, scrollback, frames, onScreen };
}

const turn = (user: string, answer: string[]): SessionEvent[] => [
  { type: "user", text: user },
  ...answer.map((text) => ({ type: "assistant-delta" as const, text })),
  { type: "assistant-done" },
  { type: "turn-end" },
];

test("a whole turn reads back as the user asked, then the answer", () => {
  const { onScreen } = play(turn("what is 6 times 7?", ["Six times ", "seven is 42.\n", "Anything else?"]), 40);

  // The user's turn is already in scrollback; the answer's tail is still live
  // because it is the last thing written and the turn has only just ended.
  const text = onScreen().join("\n");
  assert.match(text, /▶ what is 6 times 7\?/);
  assert.match(text, /Six times seven is 42\./);
});

test("each thing the user reads appears exactly once, whatever the pressure", () => {
  const { onScreen } = play(turn("hi", ["first line\n", "second line\n", "tail"]), 40, 0);
  const everything = onScreen();

  for (const expected of ["▶ hi", "first line", "second line", "tail"]) {
    assert.equal(
      everything.filter((row) => row.includes(expected)).length,
      1,
      `${expected} must appear exactly once on screen`,
    );
  }
});

test("while a tool runs, the transcript says what it is doing", () => {
  // The running form is a *live* row: it exists in the viewport while the call
  // is in flight and is replaced when the call reports. So it is asserted where
  // it lives, not on the accumulated screen — an intermediate viewport state is
  // not scrollback and must not be expected there.
  const session = new Session();
  session.apply({ type: "user", text: "list the files" });
  session.apply({ type: "assistant-delta", text: "Let me look.\n" });
  session.apply({ type: "tool-start", id: "t1", name: "bash", summary: "ls" });

  const live = session.render(40).viewport.join("\n");
  assert.match(live, /▌ bash — ls …/, "it says what is running");
  assert.doesNotMatch(live, /3 files/, "and does not claim a result it does not have");
  assert.equal(session.runningTools, 1);
});

test("a finished tool is one line of record, and the running form is gone", () => {
  const { onScreen, session } = play(
    [
      { type: "user", text: "list the files" },
      { type: "assistant-delta", text: "Let me look.\n" },
      { type: "tool-start", id: "t1", name: "bash", summary: "ls" },
      { type: "tool-end", id: "t1", ok: true, summary: "3 files" },
      { type: "assistant-delta", text: "There are three files." },
      { type: "assistant-done" },
      { type: "turn-end" },
    ],
    40,
    0,
  );

  const all = onScreen().join("\n");
  assert.match(all, /▌ bash — 3 files/, "when it is done, it is one line of record");
  assert.doesNotMatch(all, /ls …/, "and the running form is gone, not both");
  assert.ok(!session.streaming);

  // The text before the tool and the text after it are two blocks, not one
  // paragraph that silently grew around the call.
  assert.match(all, /Let me look\./);
  assert.match(all, /There are three files\./);
});

test("a failed tool says so", () => {
  const { onScreen } = play(
    [
      { type: "tool-start", id: "t1", name: "bash", summary: "false" },
      { type: "tool-end", id: "t1", ok: false, summary: "exit 1" },
      { type: "turn-end" },
    ],
    60,
  );
  const all = onScreen().join("\n");
  assert.match(all, /▌ bash — exit 1 {2}\(failed\)/);
});

test("settled blocks retire into scrollback and stop being redrawn", () => {
  const { session, scrollback, onScreen } = play(
    turn("please answer at length", ["line one\n", "line two\n", "line three\n", "line four\n"]),
    40,
    2,
  );
  const frame = session.render(40);

  assert.ok(
    frame.viewport.length <= 2,
    `the live region is bounded by keepLive, got ${frame.viewport.length} rows`,
  );
  assert.ok(scrollback.length > 0, "and what it gave up is in scrollback");
  assert.match(onScreen().join("\n"), /line four|line three/);
});

test("a second answer after a tool call is a second block", () => {
  const { onScreen } = play(
    [
      { type: "user", text: "do it" },
      { type: "assistant-delta", text: "before\n" },
      { type: "tool-start", id: "t1", name: "bash" },
      { type: "tool-end", id: "t1", ok: true },
      { type: "assistant-delta", text: "after\n" },
      { type: "assistant-done" },
      { type: "turn-end" },
    ],
    40,
    0,
  );
  const rows = onScreen();
  assert.deepEqual(
    rows.filter((r) => r === "before"),
    ["before"],
    "the interrupted answer keeps its own row",
  );
  assert.deepEqual(rows.filter((r) => r === "after"), ["after"]);
});

test("streaming and runningTools report the session's actual state", () => {
  const session = new Session();
  assert.equal(session.streaming, false);
  assert.equal(session.runningTools, 0);

  session.apply({ type: "assistant-delta", text: "thinking out loud" });
  assert.equal(session.streaming, true, "an answer in progress is streaming");

  session.apply({ type: "tool-start", id: "t1", name: "bash" });
  assert.equal(session.runningTools, 1);
  assert.equal(session.streaming, false, "a tool call ends the answer block");

  session.apply({ type: "tool-end", id: "t1", ok: true });
  assert.equal(session.runningTools, 0);
});

test("a question appears where the turn reached it, and the answer is what remains", () => {
  const call: ToolCall = { toolName: "bash", input: { command: "git push origin main" } };
  const prompt = approvalPrompt(call, decide(call, { project: [], global: [], deny: [] }))!;
  const session = new Session({ keepLive: 0 });
  session.apply({ type: "user", text: "ship it" });
  session.apply({ type: "assistant-delta", text: "Pushing now.\n" });
  session.apply({ type: "ask", prompt });

  const asked = session.render(62);
  const question = [...asked.history, ...asked.viewport].join("\n");
  assert.match(question, /\? git push origin main/, "the command, in the words it was written in");
  assert.match(question, /\[allow once\]/);
  assert.match(question, /approve git push\* in this checkout/, "what 'always' would store");
  assert.ok(session.awaitingAnswer, "and the session knows it is waiting");

  assert.equal(session.answer("always-project"), true);
  assert.equal(session.awaitingAnswer, undefined, "answering ends the wait");

  const decided = session.render(62);
  // Both frames' scrollback: a frame's `history` is the part of it that has not
  // been delivered yet, so the rows the question's frame retired are only in
  // *that* frame. Reading one frame's delta and calling it "the screen" is the
  // mistake this suite has made more than once.
  const record = [...asked.history, ...decided.history, ...decided.viewport].join("\n");
  assert.match(record, /→ always, this project — approve git push\* in this checkout/);
  assert.doesNotMatch(record, /\[allow once\]/, "the menu is gone; the decision is what stays");
  assert.match(record, /Pushing now\./, "and the turn around it is untouched");
});

test("an answer with nowhere to go is refused, not silently ignored", () => {
  const session = new Session();
  assert.equal(session.answer("once"), false, "there is no question waiting");
  assert.equal(session.awaitingAnswer, undefined);
});

test("what memory knows appears in the turn, and retires like anything else", () => {
  const { onScreen, session } = play(
    [
      { type: "user", text: "what do you remember?" },
      { type: "memory", lines: ["memory: 2 nodes", "  the rebuild [tasks] episode"] },
      { type: "assistant-delta", text: "Two things.\n" },
      { type: "assistant-done" },
      { type: "turn-end" },
    ],
    60,
    0,
  );

  const screen = onScreen().join("\n");
  assert.match(screen, /memory: 2 nodes/);
  assert.match(screen, /the rebuild \[tasks\] episode/);
  assert.match(screen, /Two things\./, "and the answer around it is intact");
  assert.deepEqual(session.transcript.render(60).viewport, [], "the panel is history once the turn ends");
});
