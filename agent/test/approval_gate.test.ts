/**
 * Approval-gate extension tests: pure decision logic, no TUI needed.
 * Policy mirrors src/approval.ts: gated tools only, SEA_APPROVAL_MODE=interactive
 * + TTY prompts via ctx.ui.confirm, deny blocks, everything else fails open.
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  decideApproval,
  GATED_TOOLS,
  summarizeToolCall,
} from "../extensions/approval-gate.ts";
import {
  approve,
  setDelegatedApproval,
  approvalConfig,
} from "../src/approval.ts";
import { PassThrough } from "node:stream";

const ttyEnv = () => ({ SEA_APPROVAL_MODE: "interactive" } as NodeJS.ProcessEnv);

function ui(answer: boolean, calls: string[] = []) {
  return {
    async confirm(title: string, message: string) {
      calls.push(`${title}|${message}`);
      return answer;
    },
  };
}

test("only mutating tools are gated", () => {
  assert.deepEqual([...GATED_TOOLS].sort(), ["apply_edit", "bash_exec", "write_file"]);
});

test("non-gated tool auto-approves even in interactive TTY mode", async () => {
  const res = await decideApproval({ toolName: "read_file", input: { path: "x" } }, ui(false), ttyEnv(), true);
  assert.deepEqual(res, {});
});

test("mode unset / non-interactive auto-approves", async () => {
  const res = await decideApproval({ toolName: "bash_exec", input: { command: "ls" } }, ui(false), {}, true);
  assert.deepEqual(res, {});
  const res2 = await decideApproval(
    { toolName: "bash_exec", input: { command: "ls" } },
    ui(false),
    { SEA_APPROVAL_MODE: "0" } as NodeJS.ProcessEnv,
    true,
  );
  assert.deepEqual(res2, {});
});

test("non-TTY fails open even in interactive mode", async () => {
  const res = await decideApproval(
    { toolName: "write_file", input: { path: "a", content: "b" } },
    ui(false),
    ttyEnv(),
    false,
  );
  assert.deepEqual(res, {});
});

test("deny blocks with a reason naming the tool and action", async () => {
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "rm -rf /" } },
    ui(false),
    ttyEnv(),
    true,
  );
  assert.equal(res.block, true);
  assert.match(res.reason!, /denied bash_exec/);
  assert.match(res.reason!, /rm -rf \//);
});

test("approve allows the call", async () => {
  const res = await decideApproval(
    { toolName: "apply_edit", input: { path: "f.ts", old_str: "aa", new_str: "bb" } },
    ui(true),
    ttyEnv(),
    true,
  );
  assert.deepEqual(res, {});
});

test("summaries match the in-tool gate strings", () => {
  assert.equal(summarizeToolCall("bash_exec", { command: "echo hi" }), "$ echo hi");
  assert.equal(
    summarizeToolCall("write_file", { path: "x.ts", content: "a\nb" }),
    "write 2 lines (3 bytes) to x.ts",
  );
  assert.equal(
    summarizeToolCall("apply_edit", { path: "y.ts", old_str: "aaa", new_str: "b" }),
    "replace a 3-char match with 1 chars in y.ts",
  );
});

test("delegated mode silences the in-tool readline gate", async () => {
  approvalConfig.input = new PassThrough(); // no isTTY anyway, but force semantics
  approvalConfig.output = new PassThrough();
  approvalConfig.forceTty = true;
  process.env.SEA_APPROVAL_MODE = "interactive";
  try {
    setDelegatedApproval(true);
    assert.equal(await approve({ tool: "bash_exec", summary: "$ echo hi" }), true);
  } finally {
    setDelegatedApproval(false);
    delete process.env.SEA_APPROVAL_MODE;
  }
});
