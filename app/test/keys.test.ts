/**
 * Keys to answers, and — the part that matters — keys to nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceForKey, effectOfKey, keyHints } from "../src/policy/keys.ts";
import { approvalPrompt, type ApprovalPrompt } from "../src/policy/prompt.ts";
import { decide, type ToolCall } from "../src/policy/gate.ts";

const bash = (command: string): ToolCall => ({ toolName: "bash", input: { command } });
const askable = (command: string): ApprovalPrompt =>
  approvalPrompt(bash(command), decide(bash(command), { project: [], global: [], deny: [] }))!;

/** A path: no "always" on offer, so the numbers line up differently. */
const pathOnly: ApprovalPrompt = approvalPrompt(
  { toolName: "write_file", input: { path: "/etc/hosts" } },
  decide({ toolName: "write_file", input: { path: "/etc/hosts" } }, { project: [], global: [], deny: [] }),
)!;

test("numbers pick the option that was shown at that position", () => {
  const prompt = askable("npm test");
  assert.equal(choiceForKey("1", prompt), "once");
  assert.equal(choiceForKey("2", prompt), "always-project");
  assert.equal(choiceForKey("3", prompt), "always-everywhere");
  assert.equal(choiceForKey("4", prompt), "deny");
  assert.equal(choiceForKey("5", prompt), "other");
});

test("the numbers follow the offer, not a fixed menu", () => {
  // With no "always" available, position 2 is the refusal — which is the point
  // of numbering what is shown rather than what usually exists.
  assert.deepEqual(pathOnly.options.map((o) => o.id), ["once", "deny", "other"]);
  assert.equal(choiceForKey("2", pathOnly), "deny");
  assert.equal(choiceForKey("4", pathOnly), undefined, "there is no fourth option here");
});

test("the mnemonics work, and escape refuses", () => {
  const prompt = askable("npm test");
  assert.equal(choiceForKey("a", prompt), "once");
  assert.equal(choiceForKey("enter", prompt), "once");
  assert.equal(choiceForKey("d", prompt), "deny");
  assert.equal(choiceForKey("escape", prompt), "deny");
  assert.equal(choiceForKey("o", prompt), "other");
});

test("a key that means nothing does nothing", () => {
  const prompt = askable("npm test");
  for (const key of ["", " ", "x", "q", "9", "\t", "ctrl+c"]) {
    assert.equal(choiceForKey(key, prompt), undefined, `${JSON.stringify(key)} must not decide anything`);
    assert.deepEqual(effectOfKey(key, prompt), { kind: "none" });
  }
});

test("a question that answers itself would be the bug, so nothing defaults", () => {
  // The safe default is deny, and it is safe only when chosen: no key here
  // produces a decision the reader did not make.
  const prompt = askable("npm test");
  // Note what is NOT in this list: "Enter"/"ENTER" and a bare carriage return
  // are the one affirmative, because that is the key a reader presses. Case is
  // irrelevant and the raw control character counts — a keymap that answered
  // only to the word "enter" could not be used by pressing it.
  const undecided = ["", " ", "x", "q", "escape!", "esc!", "returning"] as const;
  for (const key of undecided) {
    const effect = effectOfKey(key, prompt);
    assert.notEqual(effect.kind, "answer", `${JSON.stringify(key)} must not answer`);
  }
  assert.deepEqual(effectOfKey("enter", prompt), { kind: "answer", choice: "once" });
  assert.deepEqual(effectOfKey("\r", prompt), { kind: "answer", choice: "once" }, "the key itself");
});

test("an 'other' answer is routed to typing, not to a decision", () => {
  const prompt = askable("npm test");
  assert.deepEqual(effectOfKey("o", prompt), { kind: "other" });
  assert.deepEqual(effectOfKey("5", prompt), { kind: "other" }, "by number too");
});

test("the hints name the keys that actually exist for this question", () => {
  const hints = keyHints(askable("npm test"));
  assert.match(hints, /1\/a allow once/, `hints were: ${hints}`);
  assert.match(hints, /[45]\/d don't allow/, `hints were: ${hints}`);
  assert.match(hints, /other/, `hints were: ${hints}`);
  const pathHints = keyHints(pathOnly);
  assert.doesNotMatch(pathHints, /this project/, `no hint for an option that was not offered: ${pathHints}`);
});
