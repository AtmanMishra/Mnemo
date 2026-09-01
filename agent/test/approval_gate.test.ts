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
  isSubagentChild,
  summarizeToolCall,
  SUBAGENT_CHILD_ENV,
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
  assert.deepEqual([...GATED_TOOLS].sort(), ["apply_edit", "bash_exec", "ipy_run", "write_file"]);
});

import type { Permissions } from "../src/permissions.ts";

// --- 12.1 (0384ee03): ipy_run is gated like bash --------------------------

test("ipy_run prompts in interactive TTY mode and denial blocks it", async () => {
  const calls: string[] = [];
  const res = await decideApproval(
    { toolName: "ipy_run", input: { code: "import os\nos.system('rm -rf /')" } },
    ui(false, calls), ttyEnv(), true,
  );
  assert.equal(res.block, true, "a python cell is bash wearing a kernel — it must prompt");
  assert.match(res.reason!, /user denied ipy_run/);
  assert.match(calls[0]!, /py> import os/, "the prompt shows the first line of code");
  const ok = await decideApproval(
    { toolName: "ipy_run", input: { code: "1 + 1" } }, ui(true), ttyEnv(), true,
  );
  assert.deepEqual(ok, {}, "user approval lets it through");
});

test("ipy_run summarize keeps the summary short", () => {
  const s = summarizeToolCall("ipy_run", { code: "x = 1\ny = 2\n".repeat(20) });
  assert.ok(s.length < 140, s);
  assert.match(s, /py> x = 1/);
  assert.match(s, /\d+ lines/);
});

// --- 12.1 (b6afa93e): sub-agent children fail CLOSED ----------------------

const childEnv = () => ({
  MNEMO_APPROVAL_MODE: "interactive",
  [SUBAGENT_CHILD_ENV]: "1",
} as NodeJS.ProcessEnv);

test("isSubagentChild reads the env flag", () => {
  assert.equal(isSubagentChild({ [SUBAGENT_CHILD_ENV]: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(isSubagentChild({} as NodeJS.ProcessEnv), false);
});

test("a sub-agent child without a TTY is denied mutating tools", async () => {
  for (const toolName of ["bash_exec", "write_file", "apply_edit", "ipy_run"]) {
    const input: Record<string, unknown> =
      toolName === "bash_exec" ? { command: "ls" } :
      toolName === "ipy_run" ? { code: "1" } :
      toolName === "write_file" ? { path: "a", content: "b" } :
      { path: "a", old_str: "x", new_str: "y" };
    const res = await decideApproval({ toolName, input }, ui(true), childEnv(), false);
    assert.equal(res.block, true, `${toolName} must fail closed in a child`);
    assert.match(res.reason!, /sub-agent has no operator/, toolName);
  }
});

test("an allow rule still passes in a sub-agent child", async () => {
  const perms: Permissions = { version: 1, rules: [{ tool: "bash_exec", pattern: "git *", action: "allow" }], default: "ask" };
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "git status" } },
    ui(false), childEnv(), false, perms,
  );
  assert.deepEqual(res, {}, "explicit pre-approval is the escape hatch");
});

test("a deny rule still holds in a sub-agent child, no prompt needed", async () => {
  const perms: Permissions = { version: 1, rules: [{ tool: "bash_exec", pattern: "rm *", action: "deny" }], default: "ask" };
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "rm -rf /" } },
    ui(true), childEnv(), false, perms,
  );
  assert.equal(res.block, true);
  assert.match(res.reason!, /denied by/);
});

test("non-gated tools in a child still fail open (read-only work continues)", async () => {
  const res = await decideApproval(
    { toolName: "read_file", input: { path: "x" } }, ui(false), childEnv(), false,
  );
  assert.deepEqual(res, {});
});

test("a non-TTY parent (automation) is unaffected by the child rule", async () => {
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "ls" } },
    ui(false), { MNEMO_APPROVAL_MODE: "interactive" } as NodeJS.ProcessEnv, false,
  );
  assert.deepEqual(res, {}, "piped parent runs keep failing open");
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
