/**
 * The loop, driven by strings — which is the point of it not owning a terminal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Composer, type LoopHost } from "../src/input/loop.ts";
import { approvalPrompt, type ApprovalPrompt } from "../src/policy/prompt.ts";
import { decide, type ToolCall } from "../src/policy/gate.ts";

function host() {
  const calls: string[] = [];
  const host: LoopHost = {
    submit: (text) => calls.push(`submit:${text}`),
    answer: (choice, note) => calls.push(note === undefined ? `answer:${choice}` : `answer:${choice}:${note}`),
    interrupt: () => calls.push("interrupt"),
    exit: () => calls.push("exit"),
    changed: () => calls.push("changed"),
  };
  return { host, calls, composer: new Composer(host), drawn: () => calls.filter((c) => c === "changed").length };
}

const askable = (command: string): ApprovalPrompt => {
  const call: ToolCall = { toolName: "bash", input: { command } };
  return approvalPrompt(call, decide(call, { project: [], global: [], deny: [] }))!;
};

test("typing then enter submits, and the prompt is left empty", () => {
  const { composer, calls } = host();
  composer.push("hello");
  assert.equal(composer.buffer, "hello");
  composer.push("\r");
  assert.deepEqual(calls.filter((c) => c.startsWith("submit")), ["submit:hello"]);
  assert.equal(composer.buffer, "", "the prompt is ready for the next message");
});

test("the screen is redrawn when something changed, and not otherwise", () => {
  const { composer, calls } = host();
  composer.push("ab");
  const afterTyping = calls.filter((c) => c === "changed").length;
  assert.ok(afterTyping > 0, "typing is visible");
  composer.push("\x1b[D"); // left arrow: nothing in this interface uses it
  assert.equal(calls.filter((c) => c === "changed").length, afterTyping, "a key that did nothing did not redraw");
});

test("a question is answered by its keys, and the answer is the only thing that closes it", () => {
  const { composer, calls } = host();
  composer.ask(askable("npm test"));
  composer.push("d");
  assert.deepEqual(calls.filter((c) => c.startsWith("answer")), ["answer:deny"]);
  assert.equal(composer.question, undefined, "answered, so nothing is waiting");
});

test("an 'other' answer is written, and writing it sends it", () => {
  const { composer, calls } = host();
  composer.ask(askable("npm test"));
  composer.push("o");
  assert.equal(composer.state.answering, true);
  composer.push("only if the tests pass");
  composer.push("\r");
  assert.deepEqual(calls.filter((c) => c.startsWith("answer")), ["answer:other:only if the tests pass"]);
  assert.equal(composer.question, undefined);
  assert.equal(composer.buffer, "", "the reply is sent, not left in the prompt");
});

test("a draft survives a question arriving mid-sentence", () => {
  const { composer, calls } = host();
  composer.push("deploy the thing after ");
  composer.ask(askable("git push origin main"));
  composer.push("a"); // "a" is allow-once here, not the letter a
  assert.deepEqual(calls.filter((c) => c.startsWith("answer")), ["answer:once"]);
  assertsBufferKept(composer);
});

function assertsBufferKept(composer: Composer) {
  assert.equal(composer.buffer, "deploy the thing after ", "what the reader was writing is still there");
}

test("interrupt does not answer the question it interrupts", () => {
  const { composer, calls } = host();
  composer.ask(askable("npm test"));
  composer.push("\x03");
  assert.deepEqual(calls.filter((c) => c === "interrupt"), ["interrupt"]);
  assert.ok(composer.question, "stopping a turn is not a decision about the call");
  composer.push("1");
  assert.deepEqual(calls.filter((c) => c.startsWith("answer")), ["answer:once"]);
});

test("a split escape sequence is held until it is whole", () => {
  const { composer } = host();
  composer.push("\x1b[");
  assert.equal(composer.buffer, "", "nothing typed, nothing submitted");
  composer.push("A");
  composer.tick();
  assert.equal(composer.buffer, "");
});

test("a lone escape is settled by the tick, not by guessing", () => {
  const { composer, calls } = host();
  composer.push("\x1b");
  assert.equal(calls.includes("exit"), false, "an escape must not do anything drastic");
  composer.tick();
  assert.equal(composer.buffer, "");
});

test("ctrl+d exits, and only when the prompt is empty", () => {
  const { composer, calls } = host();
  composer.push("\x04");
  assert.deepEqual(calls.filter((c) => c === "exit"), ["exit"]);
  const { composer: busy, calls: busyCalls } = host();
  busy.push("half-written");
  busy.push("\x04");
  assert.equal(busyCalls.includes("exit"), false, "not with work in progress");
});
