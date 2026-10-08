/**
 * The guarded path, tested by what does and does not happen.
 *
 * Every test here can be read as a sentence about a side effect: it ran, it did
 * not run, it ran and gave back a grant. That is the only interesting thing
 * about this module, and a fake runner plus a fake answer is enough to prove it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guard } from "../src/policy/dispatch.ts";
import type { Grants, ToolCall } from "../src/policy/gate.ts";
import type { ApprovalChoice } from "../src/policy/prompt.ts";

const bash = (command: string): ToolCall => ({ toolName: "bash", input: { command } });
const NO_GRANTS: Grants = { project: [], global: [], deny: [] };

/** A runner that records that it ran, and an ask that records what it was asked. */
function harness(answer: ApprovalChoice, note?: string, outcome: "ok" | "throws" = "ok") {
  const ran: string[] = [];
  const asked: string[] = [];
  return {
    ran,
    asked,
    options: (call: ToolCall, grants: Grants = NO_GRANTS, mode = {}) => ({
      call,
      grants,
      mode,
      run: async () => {
        ran.push(String(call.input.command));
        if (outcome === "throws") throw new Error("the tool exploded");
        return "done";
      },
      ask: async (prompt: { title: string }): Promise<{ choice: ApprovalChoice; note?: string }> => {
        asked.push(prompt.title);
        return { choice: answer, note };
      },
    }),
  };
}

test("an allowed call runs without a question", async () => {
  const h = harness("deny"); // would refuse if asked — but it must not be asked
  const result = await guard(h.options(bash("npm test"), { project: ["npm test*"], global: [], deny: [] }));
  assert.equal(result.ran, true);
  assert.equal(result.result, "done");
  assert.deepEqual(h.asked, [], "an approval already given is not re-litigated");
});

test("a denied call does not run, whatever the mode", async () => {
  const h = harness("once");
  const result = await guard(
    h.options(bash("rm -rf build"), { project: [], global: [], deny: ["rm*"] }, { yolo: true }),
  );
  assert.equal(result.ran, false);
  assert.equal(result.decision, "deny");
  assert.match(String(result.error), /refused by a rule/);
  assert.deepEqual(h.ran, [], "the runner must not have been called at all");
  assert.deepEqual(h.asked, [], "and there was nothing to ask");
});

test("a question is asked, and 'once' runs it without granting anything", async () => {
  const h = harness("once");
  const result = await guard(h.options(bash("git push origin main")));
  assert.equal(result.ran, true);
  assert.equal(result.grant, undefined, "once means once");
  assert.deepEqual(h.asked, ["git push origin main"], "asked in the words that will be shown");
});

test("'always' runs it and hands back the grant to store", async () => {
  const project = harness("always-project");
  const first = await guard(project.options(bash("git push origin main")));
  assert.equal(first.ran, true);
  assert.deepEqual(first.grant, { scope: "project", pattern: "git push*" });

  const everywhere = harness("always-everywhere");
  const second = await guard(everywhere.options(bash("cargo publish")));
  assert.deepEqual(second.grant, { scope: "everywhere", pattern: "cargo publish*" });
});

test("refusing runs nothing and says so", async () => {
  const h = harness("deny");
  const result = await guard(h.options(bash("npm publish")));
  assert.equal(result.ran, false);
  assert.equal(result.decision, "deny");
  assert.equal(result.error, "you did not allow this");
  assert.deepEqual(h.ran, []);
});

test("an answer in the reader's own words is carried back, not paraphrased", async () => {
  const h = harness("other", "run it in the sandbox instead");
  const result = await guard(h.options(bash("docker run --privileged x")));
  assert.equal(result.ran, false);
  assert.match(String(result.error), /you said: run it in the sandbox instead/);
  assert.deepEqual(h.ran, []);
});

test("an 'other' with nothing said is refused rather than guessed at", async () => {
  const h = harness("other");
  const result = await guard(h.options(bash("docker run --privileged x")));
  assert.equal(result.ran, false);
  assert.match(String(result.error), /without saying what should happen instead/);
});

test("a call that cannot be generalised never earns a grant", async () => {
  // A path: the prompt offers no "always", so an answer claiming one is refused
  // rather than stored — storing it would approve calls the reader never saw.
  const h = harness("always-project");
  const result = await guard(h.options({ toolName: "write_file", input: { path: "/etc/hosts" } }));
  assert.equal(result.ran, false);
  assert.equal(result.grant, undefined);
  assert.match(String(result.error), /cannot be approved for the future/);
});

test("a run that throws is a result, not an escape", async () => {
  const h = harness("once", undefined, "throws");
  const result = await guard(h.options(bash("false")));
  assert.equal(result.ran, true, "it ran — it failed, and those are different things");
  assert.match(String(result.error), /the tool exploded/);
  assert.deepEqual(h.ran, ["false"], "it did run — it failed");
});
