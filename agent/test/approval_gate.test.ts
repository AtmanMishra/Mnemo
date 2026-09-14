/**
 * Approval-gate extension tests: pure decision logic, no TUI needed.
 *
 * Policy (issue #15): with MNEMO_APPROVAL_MODE=interactive, gated tools ask
 * through pi's dialog protocol whenever the run has a dialog-capable UI —
 * ctx.hasUI / ctx.mode === "rpc", NOT stdin being a TTY. Deny rules and plan
 * mode always block; every other mode (off, 0, unset) force-approves; a
 * sub-agent child with no UI fails CLOSED; a run with no UI fails open.
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  approvalInteractive,
  approvalExtensionFactory,
  decideApproval,
  GATED_TOOLS,
  hasDialogUI,
  isSubagentChild,
  summarizeToolCall,
  SUBAGENT_CHILD_ENV,
} from "../extensions/approval-gate.ts";
import {
  approve,
  setDelegatedApproval,
  isDelegatedApproval,
  approvalConfig,
} from "../src/approval.ts";
import { DEFAULT_PERMISSIONS, type Permissions } from "../src/permissions.ts";
import { isPlanMode, setPlanMode } from "../src/plan_mode.ts";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const interactiveEnv = () => ({ SEA_APPROVAL_MODE: "interactive" } as NodeJS.ProcessEnv);

/** A pi ExtensionContext as far as the gate is concerned: a UI + hasUI flag. */
function uiCtx(answer: boolean, calls: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    mode: "tui",
    ui: ui(answer, calls),
    ...extra,
  };
}

function ui(answer: boolean, calls: string[] = []) {
  return {
    async confirm(title: string, message: string) {
      calls.push(`${title}|${message}`);
      return answer;
    },
  };
}

/** Temporarily set MNEMO_APPROVAL_MODE; returns a restore function. */
function withApprovalMode(mode: string | undefined): () => void {
  const prev = process.env.MNEMO_APPROVAL_MODE;
  if (mode === undefined) delete process.env.MNEMO_APPROVAL_MODE;
  else process.env.MNEMO_APPROVAL_MODE = mode;
  return () => {
    if (prev === undefined) delete process.env.MNEMO_APPROVAL_MODE;
    else process.env.MNEMO_APPROVAL_MODE = prev;
  };
}

test("only mutating tools are gated", () => {
  assert.deepEqual([...GATED_TOOLS].sort(), ["apply_edit", "bash_exec", "ipy_run", "write_file"]);
});

// --- 15: a dialog UI is what makes the gate able to ask -------------------

test("hasDialogUI keys on ctx.hasUI and the rpc mode, never on stdin", () => {
  assert.equal(hasDialogUI({ hasUI: true }), true);
  assert.equal(hasDialogUI({ hasUI: false, mode: "rpc" }), true, "RPC dialogs are real dialogs");
  assert.equal(hasDialogUI({ hasUI: false, mode: "print" }), false);
  assert.equal(hasDialogUI({ hasUI: false, mode: "tui" }), false);
  assert.equal(hasDialogUI({ mode: "print" }), false);
  assert.equal(hasDialogUI(undefined), false);
});

test("issue #15: with a UI, the gate asks although stdin is not a TTY (the TUI path)", async () => {
  const calls: string[] = [];
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "rm -rf build" } },
    ui(false, calls), interactiveEnv(), true,
  );
  assert.equal(res.block, true, "denial must block");
  assert.match(res.reason!, /user denied bash_exec/);
  assert.equal(calls.length, 1, "the user was asked exactly once");

  const allowed = await decideApproval(
    { toolName: "bash_exec", input: { command: "ls" } },
    ui(true), interactiveEnv(), true,
  );
  assert.deepEqual(allowed, {}, "approval lets it through");
});

test("issue #15: the gate no longer consults stdin's TTY flag", () => {
  // The old condition was mode === interactive AND process.stdin.isTTY; the
  // TUI spawns pi with a pipe, which is precisely how the gate failed open.
  // No stub can make stdin a TTY, so this pins the source: the file must not
  // reference isTTY at all, and the decision must take the UI presence from
  // pi's context.
  const source = fs.readFileSync(
    fileURLToPath(new URL("../extensions/approval-gate.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(!/isTTY/.test(source), "the gate must not inspect stdin's TTY flag");
  assert.match(source, /hasDialogUI\(ctx\)/, "the decision comes from pi's context");
});

test("with no UI, interactive mode still fails open (print/piped runs)", async () => {
  const calls: string[] = [];
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "ls" } },
    ui(false, calls), interactiveEnv(), false,
  );
  assert.deepEqual(res, {});
  assert.equal(calls.length, 0, "nothing to ask");
});

test("mode off/0/unset force-approves even when a UI could ask (the escape hatch)", async () => {
  // The gate never turns itself on: prompting is the MNEMO_APPROVAL_MODE=
  // interactive opt-in, and everything else is the force-approve hatch.
  for (const env of [
    {}, { MNEMO_APPROVAL_MODE: "off" }, { MNEMO_APPROVAL_MODE: "0" },
    { SEA_APPROVAL_MODE: "off" }, { SEA_APPROVAL_MODE: "0" },
  ] as NodeJS.ProcessEnv[]) {
    const calls: string[] = [];
    const res = await decideApproval(
      { toolName: "bash_exec", input: { command: "rm -rf /" } },
      ui(false, calls), env, true,
    );
    assert.deepEqual(res, {}, `${JSON.stringify(env)} must force-approve`);
    assert.equal(calls.length, 0, "the escape hatch must not prompt");
  }
});

test("approvalInteractive is exactly the interactive opt-in", () => {
  assert.equal(approvalInteractive({ MNEMO_APPROVAL_MODE: "interactive" } as NodeJS.ProcessEnv), true);
  assert.equal(approvalInteractive({ SEA_APPROVAL_MODE: " INTERACTIVE " } as NodeJS.ProcessEnv), true);
  assert.equal(approvalInteractive({ MNEMO_APPROVAL_MODE: "off" } as NodeJS.ProcessEnv), false);
  assert.equal(approvalInteractive({ SEA_APPROVAL_MODE: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(approvalInteractive({} as NodeJS.ProcessEnv), false);
});

test("ipy_run prompts with a UI and denial blocks it", async () => {
  const calls: string[] = [];
  const res = await decideApproval(
    { toolName: "ipy_run", input: { code: "import os\nos.system('rm -rf /')" } },
    ui(false, calls), interactiveEnv(), true,
  );
  assert.equal(res.block, true, "a python cell is bash wearing a kernel — it must prompt");
  assert.match(res.reason!, /user denied ipy_run/);
  assert.match(calls[0]!, /py> import os/, "the prompt shows the first line of code");
  const ok = await decideApproval(
    { toolName: "ipy_run", input: { code: "1 + 1" } }, ui(true), interactiveEnv(), true,
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

test("a sub-agent child without a UI is denied mutating tools", async () => {
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

test("a child that WOULD have a UI asks instead of failing closed", async () => {
  // Children are spawned non-interactively so this is theoretical, but the
  // rule is "a child fails closed on an ask nobody can answer" — with a UI
  // there IS someone to answer, so the ask happens.
  const calls: string[] = [];
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "ls" } },
    ui(false, calls), childEnv(), true,
  );
  assert.equal(res.block, true);
  assert.match(res.reason!, /user denied/);
  assert.equal(calls.length, 1);
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

test("a deny rule blocks even with a UI and even in off mode", async () => {
  const perms: Permissions = { version: 1, rules: [{ tool: "bash_exec", pattern: "rm *", action: "deny" }], default: "ask" };
  const calls: string[] = [];
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "rm -rf /" } },
    ui(true, calls), { MNEMO_APPROVAL_MODE: "off" } as NodeJS.ProcessEnv, true, perms,
  );
  assert.equal(res.block, true, "an escape hatch must not disable deny rules");
  assert.equal(calls.length, 0);
});

test("non-gated tools in a child still fail open (read-only work continues)", async () => {
  const res = await decideApproval(
    { toolName: "read_file", input: { path: "x" } }, ui(false), childEnv(), false,
  );
  assert.deepEqual(res, {});
});

test("a run with no UI (automation) is unaffected by the child rule", async () => {
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "ls" } },
    ui(false), interactiveEnv(), false,
  );
  assert.deepEqual(res, {}, "piped runs with no UI keep failing open");
});

test("non-gated tool auto-approves even with a UI", async () => {
  const calls: string[] = [];
  const res = await decideApproval(
    { toolName: "read_file", input: { path: "x" } }, ui(false, calls), interactiveEnv(), true,
  );
  assert.deepEqual(res, {});
  assert.equal(calls.length, 0, "read-only tools are not gated and never prompt");
});

test("deny blocks with a reason naming the tool and action", async () => {
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "rm -rf /" } },
    ui(false), interactiveEnv(), true,
  );
  assert.equal(res.block, true);
  assert.match(res.reason!, /denied bash_exec/);
  assert.match(res.reason!, /rm -rf \//);
});

test("approve allows the call", async () => {
  const res = await decideApproval(
    { toolName: "apply_edit", input: { path: "f.ts", old_str: "aa", new_str: "bb" } },
    ui(true), interactiveEnv(), true,
  );
  assert.deepEqual(res, {});
});

test("plan mode blocks with a UI, a child or automation alike", async () => {
  for (const [env, uiAvailable] of [
    [{}, true], [childEnv(), false], [interactiveEnv(), false],
  ] as Array<[NodeJS.ProcessEnv, boolean]>) {
    const res = await decideApproval(
      { toolName: "bash_exec", input: { command: "ls" } },
      ui(true), env, uiAvailable, DEFAULT_PERMISSIONS, true, // plan mode
    );
    assert.equal(res.block, true);
    assert.match(res.reason!, /plan mode is on/);
  }
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

// --- factory wiring: pi's ctx is what decides -----------------------------

test("the extension factory asks through pi's ctx.ui (issue #15 wiring)", async () => {
  const handlers = new Map<string, (ev: any, ctx: any) => Promise<unknown>>();
  const fakePi = {
    on(event: string, fn: (ev: any, ctx: any) => Promise<unknown>) { handlers.set(event, fn); },
  };
  const prevPlan = isPlanMode();
  const restoreMode = withApprovalMode("interactive");
  approvalExtensionFactory(fakePi as any, DEFAULT_PERMISSIONS);
  try {
    const calls: string[] = [];
    const blocked = await handlers.get("tool_call")!(
      { toolName: "bash_exec", input: { command: "echo hi" } },
      uiCtx(false, calls),
    );
    assert.deepEqual(blocked, { block: true, reason: "ERROR: user denied bash_exec. Action was NOT executed: $ echo hi" });
    assert.equal(calls.length, 1, "the ctx.ui dialog was used");

    // A piped/print run: ctx.hasUI false -> fail open (documented)
    const piped = await handlers.get("tool_call")!(
      { toolName: "bash_exec", input: { command: "echo hi" } },
      { hasUI: false, mode: "print", ui: ui(false) },
    );
    assert.deepEqual(piped, {}, "no UI still fails open");

    // An RPC context without the hasUI flag still counts as a UI (ctx.mode)
    const rpcCalls: string[] = [];
    const rpc = await handlers.get("tool_call")!(
      { toolName: "bash_exec", input: { command: "echo hi" } },
      { mode: "rpc", ui: ui(false, rpcCalls) },
    );
    assert.equal((rpc as any).block, true, "rpc mode is a dialog UI");
    assert.equal(rpcCalls.length, 1);
  } finally {
    restoreMode();
    setDelegatedApproval(false);
    setPlanMode(prevPlan);
  }
});

test("the factory flips the in-tool gate into delegated mode", () => {
  const fakePi = { on() {} };
  const prevPlan = isPlanMode();
  try {
    approvalExtensionFactory(fakePi as any, DEFAULT_PERMISSIONS);
    assert.equal(isDelegatedApproval(), true, "no second prompt on the TUI-owned stdin");
  } finally {
    setDelegatedApproval(false);
    setPlanMode(prevPlan);
  }
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
