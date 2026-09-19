/**
 * Which input owns the keyboard, and what happens when none of them do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { route, type UiState } from "../src/input/router.ts";
import { approvalPrompt, type ApprovalPrompt } from "../src/policy/prompt.ts";
import { decide, type ToolCall } from "../src/policy/gate.ts";

const typing = (buffer = "", question?: ApprovalPrompt): UiState => ({ answering: false, buffer, question });
const answering = (buffer = "", question?: ApprovalPrompt): UiState => ({ answering: true, buffer, question });

const question: ApprovalPrompt = (() => {
  const call: ToolCall = { toolName: "bash", input: { command: "git push origin main" } };
  return approvalPrompt(call, decide(call, { project: [], global: [], deny: [] }))!;
})();

test("typing accumulates, and enter sends what was typed", () => {
  assert.deepEqual(route({ kind: "text", text: "h" }, typing()), { kind: "insert", text: "h" });
  assert.deepEqual(route({ kind: "enter" }, typing("hello")), { kind: "submit", text: "hello" });
});

test("enter on an empty prompt is nothing, not an empty turn", () => {
  assert.deepEqual(route({ kind: "enter" }, typing()), { kind: "none" });
  assert.deepEqual(route({ kind: "enter" }, typing("   ")), { kind: "submit", text: "   " }, "spaces are the reader's to send");
});

test("backspace on an empty prompt is nothing", () => {
  assert.deepEqual(route({ kind: "backspace" }, typing()), { kind: "none" });
  assert.deepEqual(route({ kind: "backspace" }, typing("ab")), { kind: "backspace" });
});

test("a question owns the keyboard while it waits", () => {
  // The bug this prevents: typing a reply into a pending question and believing
  // it refused the call.
  assert.deepEqual(route({ kind: "text", text: "z" }, typing("", question)), { kind: "none" });
  assert.deepEqual(route({ kind: "text", text: "zebra" }, typing("", question)), { kind: "none" });
  assert.deepEqual(route({ kind: "text", text: "n" }, typing("", question)), { kind: "answer", choice: "deny" }, "n is no, in as many words as it takes");
  assert.deepEqual(route({ kind: "enter" }, typing("", question)), { kind: "answer", choice: "once" });
  assert.deepEqual(route({ kind: "text", text: "d" }, typing("", question)), { kind: "answer", choice: "deny" });
});

test("other is the one way typing becomes an answer", () => {
  assert.deepEqual(route({ kind: "text", text: "o" }, typing("", question)), { kind: "begin-other" });
  // ...and while answering, enter sends the sentence rather than choosing.
  assert.deepEqual(route({ kind: "text", text: "n" }, answering("", question)), { kind: "insert", text: "n" });
  assert.deepEqual(route({ kind: "enter" }, answering("only if tests pass", question)), {
    kind: "submit",
    text: "only if tests pass",
  });
});

test("interrupt works from anywhere, including mid-question", () => {
  const ctrlC = { kind: "ctrl", letter: "c" } as const;
  assert.deepEqual(route(ctrlC, typing()), { kind: "interrupt" });
  assert.deepEqual(route(ctrlC, typing("half a message")), { kind: "interrupt" });
  assert.deepEqual(route(ctrlC, typing("", question)), { kind: "interrupt" }, "a way out cannot depend on the state being escaped");
});

test("ctrl+d exits only when there is nothing to lose", () => {
  const ctrlD = { kind: "ctrl", letter: "d" } as const;
  assert.deepEqual(route(ctrlD, typing()), { kind: "exit" });
  assert.deepEqual(route(ctrlD, typing("half a message")), { kind: "none" }, "not with work in progress");
  assert.deepEqual(route(ctrlD, typing("", question)), { kind: "none" }, "not while a call is waiting on you");
});

test("a paste is text wherever text is accepted", () => {
  assert.deepEqual(route({ kind: "paste", text: "a\nb" }, typing()), { kind: "insert", text: "a\nb" });
  assert.deepEqual(route({ kind: "paste", text: "a\nb" }, typing("", question)), { kind: "none" }, "a paste is not a decision");
});

test("keys nobody claimed do nothing", () => {
  for (const key of [{ kind: "up" }, { kind: "tab" }, { kind: "escape" }] as const) {
    assert.deepEqual(route(key, typing("some text")), { kind: "none" }, `${key.kind} must not disturb a draft`);
  }
});
