/**
 * Chunks in, keys out — tested against the shapes a terminal actually sends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyReader, textOf, type Key } from "../src/input/reader.ts";

const kinds = (keys: readonly Key[]): string[] => keys.map((k) => k.kind);

test("the ordinary keys are the ordinary keys", () => {
  const reader = new KeyReader();
  assert.deepEqual(reader.push("a"), [{ kind: "text", text: "a" }]);
  assert.deepEqual(reader.push("\r"), [{ kind: "enter" }]);
  assert.deepEqual(reader.push("\n"), [{ kind: "enter" }], "a newline is an enter too");
  assert.deepEqual(reader.push("\t"), [{ kind: "tab" }]);
  assert.deepEqual(reader.push("\x7f"), [{ kind: "backspace" }]);
  assert.deepEqual(reader.push("\x03"), [{ kind: "ctrl", letter: "c" }]);
});

test("several keys in one chunk become several keys", () => {
  const reader = new KeyReader();
  const keys = reader.push("hi there\r");
  assert.equal(textOf(keys), "hi there");
  assert.equal(keys.at(-1)!.kind, "enter");
});

test("an escape sequence split across chunks is still one key", () => {
  // The classic: `\x1b[` and `A` arriving separately must not become an Escape
  // followed by the letter A.
  const reader = new KeyReader();
  assert.deepEqual(reader.push("\x1b["), [], "nothing complete yet");
  assert.equal(reader.incomplete, true);
  assert.deepEqual(reader.push("A"), [{ kind: "up" }]);

  // ...and split the other way.
  const other = new KeyReader();
  assert.deepEqual(other.push("\x1b"), []);
  assert.deepEqual(other.push("[B"), [{ kind: "down" }]);
});

test("all four arrows, and the same sequence twice in one chunk", () => {
  const reader = new KeyReader();
  assert.deepEqual(kinds(reader.push("\x1b[A\x1b[B\x1b[C\x1b[D")), ["up", "down", "right", "left"]);
});

test("a lone escape is the escape key, but only after the wait", () => {
  const reader = new KeyReader();
  assert.deepEqual(reader.push("\x1b"), [], "it could still be the start of a sequence");
  assert.equal(reader.incomplete, true);
  assert.deepEqual(reader.flush(), [{ kind: "escape" }]);
  assert.deepEqual(reader.flush(), [], "and there is nothing left to flush");
});

test("a modified key is reported rather than typed as garbage", () => {
  const reader = new KeyReader();
  const keys = reader.push("\x1b[1;5A");
  assert.deepEqual(keys, [{ kind: "unknown", raw: "\x1b[1;5A" }]);
  assert.equal(textOf(keys), "", "it must not land in the prompt as text");
});

test("a paste is one key, not two hundred", () => {
  const reader = new KeyReader();
  const keys = reader.push("\x1b[200~line one\nline two\x1b[201~");
  assert.deepEqual(keys, [{ kind: "paste", text: "line one\nline two" }]);

  // ...and a paste cut in half mid-marker is still one paste.
  const split = new KeyReader();
  assert.deepEqual(split.push("\x1b[200~all of this\x1b[20"), []);
  assert.deepEqual(split.push("1~"), [{ kind: "paste", text: "all of this" }]);
});

test("a paste that never ends delivers what arrived instead of losing it", () => {
  const reader = new KeyReader();
  assert.deepEqual(reader.push("\x1b[200~half a paste"), []);
  assert.deepEqual(reader.flush(), [{ kind: "paste", text: "half a paste" }]);
});

test("an unrecognised byte is reported, not swallowed", () => {
  const reader = new KeyReader();
  assert.deepEqual(reader.push("\x01"), [{ kind: "unknown", raw: "\x01" }]);
  assert.deepEqual(new KeyReader().flush(), [], "nothing pending, nothing to report");
});

test("text runs through a prompt untouched", () => {
  const reader = new KeyReader();
  const typed = reader.push("/model deepseek");
  assert.equal(textOf(typed), "/model deepseek");
  assert.equal(textOf(reader.push("\r")), "", "enter is not text");
});
