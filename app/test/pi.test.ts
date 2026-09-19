/**
 * The adapter, tested against the shapes pi actually emits.
 *
 * No key, no network, no pi process: the events are plain objects matching the
 * fields the adapter reads, which is what lets this run in CI. The shapes are
 * taken from the installed package (`pi-agent-core/dist/types.d.ts`:
 * `tool_execution_start { toolCallId, toolName, args }`,
 * `tool_execution_end { toolCallId, toolName, result, isError }`,
 * `message_update { message, assistantMessageEvent }` with
 * `assistantMessageEvent.delta` for `text_delta`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session/session.ts";
import type { SessionEvent } from "../src/session/events.ts";
import {
  runTurn,
  shorten,
  summarizeToolArgs,
  summarizeToolResult,
  toSessionEvents,
  type PiLikeEvent,
} from "../src/session/pi.ts";

test("a text delta becomes an answer chunk", () => {
  const events = toSessionEvents({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  });
  assert.deepEqual(events, [{ type: "assistant-delta", text: "hello" }]);
});

test("other stream events are dropped on purpose", () => {
  for (const assistantMessageEvent of [
    { type: "text_start" },
    { type: "thinking_delta", delta: "hmm" },
    { type: "tool_call_start" },
    { type: "done" },
  ]) {
    assert.deepEqual(toSessionEvents({ type: "message_update", assistantMessageEvent }), []);
  }
  assert.deepEqual(toSessionEvents({ type: "agent_start" }), []);
  assert.deepEqual(toSessionEvents({ type: "session_info_changed" }), []);
});

test("only an assistant message ending finishes the answer", () => {
  assert.deepEqual(toSessionEvents({ type: "message_end", message: { role: "assistant" } }), [
    { type: "assistant-done" },
  ]);
  assert.deepEqual(toSessionEvents({ type: "message_end", message: { role: "user" } }), []);
});

// The real failure this caught: a provider rejected the request, pi delivered an
// assistant message with no content and an error on it, and the turn ended with
// an empty screen and exit code 0. Silence is the worst way to report a failure.
test("a rejected request becomes a visible error, never a silent empty answer", () => {
  const events = toSessionEvents({
    type: "message_end",
    message: {
      role: "assistant",
      errorMessage: '401: {"message":"Missing Authentication header","code":401}',
    },
  });
  assert.deepEqual(events[0], { type: "assistant-done" });
  assert.equal(events[1]?.type, "notice");
  const notice = events[1] as Extract<SessionEvent, { type: "notice" }>;
  assert.equal(notice.tone, "error");
  assert.match(notice.text, /could not answer/);
  assert.match(notice.text, /401/, "the reason the provider gave is carried, not paraphrased away");
});

test("a turn whose provider failed still shows something on screen", async () => {
  const pi = fakePi([
    {
      type: "message_end",
      message: { role: "assistant", errorMessage: "401: no credentials" },
    },
    { type: "turn_end" },
  ]);
  const session = new Session({ keepLive: 0 });
  await runTurn(pi, session, "hello?", { width: 60, onFrame: () => {} });

  const screen = session.transcript.history.join("\n");
  assert.match(screen, /▶ hello\?/);
  assert.match(screen, /! the model could not answer — 401: no credentials/);
});

test("a tool call carries the subject a reader recognises", () => {
  const start = toSessionEvents({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "npm test -- --watch=false" },
  });
  assert.deepEqual(start, [
    { type: "tool-start", id: "call_1", name: "bash", summary: "npm test -- --watch=false" },
  ]);

  const edit = toSessionEvents({
    type: "tool_execution_start",
    toolCallId: "call_2",
    toolName: "edit",
    args: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
  });
  assert.deepEqual(edit, [
    { type: "tool-start", id: "call_2", name: "edit", summary: "src/app.ts" },
  ]);
});

test("an unknown tool gets no summary rather than a blob", () => {
  assert.equal(summarizeToolArgs("mystery", { foo: "bar", nested: { deep: true } }), undefined);
  assert.equal(summarizeToolArgs("mystery", "not an object"), undefined);
  assert.equal(summarizeToolArgs("search", { query: "find the thing" }), "find the thing");
});

test("a tool result is summarised, and a failure is marked", () => {
  assert.deepEqual(
    toSessionEvents({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { stdout: "3 files changed" },
      isError: false,
    }),
    [{ type: "tool-end", id: "call_1", ok: true, summary: "3 files changed" }],
  );

  const failed = toSessionEvents({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: "command not found: frobnicate",
    isError: true,
  });
  assert.deepEqual(failed, [
    { type: "tool-end", id: "call_1", ok: false, summary: "command not found: frobnicate" },
  ]);
  assert.equal(summarizeToolResult({}), undefined);
  assert.equal(summarizeToolResult("   "), undefined, "whitespace is not a result");
});

test("summaries are one bounded line", () => {
  const long = "x".repeat(200);
  const short = shorten(long);
  assert.ok(short.length <= 60);
  assert.match(short, /…$/);
  assert.equal(shorten("a\nb\tc"), "a b c", "newlines and tabs collapse");
});

/** A stand-in for pi's AgentSession: emits a scripted stream when prompted. */
function fakePi(script: PiLikeEvent[]) {
  const listeners = new Set<(e: PiLikeEvent) => void>();
  return {
    subscribed: () => listeners.size,
    subscribe(listener: (e: PiLikeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      for (const event of script) for (const listener of listeners) listener(event);
      void text;
    },
  };
}

test("a whole turn runs through the adapter and lands in the transcript", async () => {
  const pi = fakePi([
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Two files " } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "changed.\n" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Details below." } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "turn_end" },
  ]);
  const session = new Session({ keepLive: 0 });
  const seen: SessionEvent[] = [];
  const frames: string[][] = [];

  await runTurn(pi, session, "what happened?", {
    width: 40,
    onFrame: (frame) => frames.push([...frame.history]),
    onEvent: (event) => seen.push(event),
  });

  assert.equal(pi.subscribed(), 0, "the listener is torn down when the turn ends");

  const screen = [...session.transcript.history].join("\n");
  assert.match(screen, /▶ what happened\?/);
  assert.match(screen, /Two files changed\./);
  assert.match(screen, /Details below\./);

  assert.deepEqual(
    seen.map((e) => e.type),
    ["user", "assistant-delta", "assistant-delta", "assistant-delta", "assistant-done", "turn-end"],
    "the session saw the turn in order, in our vocabulary",
  );
  assert.ok(frames.length > 0, "frames were painted as the turn progressed");
});

test("a failing tool in a real turn is marked, not thrown", async () => {
  const pi = fakePi([
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "false" } },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "exit 1", isError: true },
    { type: "turn_end" },
  ]);
  const session = new Session({ keepLive: 0 });
  /** Everything any frame showed, so a transient row can be asserted where it
   *  actually exists — a running tool's line lives in a viewport and is gone
   *  from the screen once the call reports. */
  const painted: string[] = [];
  await runTurn(pi, session, "run it", {
    width: 60,
    onFrame: (frame) => painted.push(...frame.history, ...frame.viewport),
  });

  const screen = session.transcript.history.join("\n");
  assert.ok(
    painted.some((row) => row.includes("▌ bash — false …")),
    "the running form was painted while the tool ran",
  );
  assert.match(screen, /▌ bash — exit 1 {2}\(failed\)/);
  assert.ok(
    !screen.includes("false …"),
    "and the durable line is the result, not the request",
  );
});
