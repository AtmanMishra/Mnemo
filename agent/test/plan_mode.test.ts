/** 4.4: plan mode is a read-only phase, expressed as permission rules. */
import { test } from "node:test";
import assert from "node:assert";
import {
  READ_ONLY_TOOLS, isPlanMode, planModeFromEnv, planModeRules, setPlanMode, withPlanMode,
} from "../src/plan_mode.ts";
import { DEFAULT_PERMISSIONS, resolveAction, type Permissions } from "../src/permissions.ts";
import { decideApproval } from "../extensions/approval-gate.ts";

const allowUI = { confirm: async () => true };
const off = {} as NodeJS.ProcessEnv;

test("read-only tools run, everything else is denied", () => {
  const p = withPlanMode(DEFAULT_PERMISSIONS, true);
  for (const t of READ_ONLY_TOOLS) {
    assert.equal(resolveAction(p, t, { path: "a" }), "allow", `${t} should stay available`);
  }
  for (const t of ["write_file", "apply_edit", "ipy_run", "create_harness",
                   "memory_write_fact", "memory_steer", "spawn_subagent", "create_skill"]) {
    assert.equal(resolveAction(p, t, { path: "a" }), "deny", `${t} must be blocked`);
  }
});

test("bash_exec is denied because it is not read-only", () => {
  // `ls` and `rm -rf /` arrive through the same tool, so the whole tool goes
  const p = withPlanMode(DEFAULT_PERMISSIONS, true);
  assert.equal(resolveAction(p, "bash_exec", { command: "ls" }), "deny");
});

test("a user allow rule cannot punch a hole in a read-only phase", () => {
  const permissive: Permissions = {
    version: 1,
    rules: [{ tool: "write_file", pattern: "*", action: "allow" }],
    default: "allow",
  };
  assert.equal(resolveAction(permissive, "write_file", { path: "a" }), "allow", "without plan mode");
  assert.equal(resolveAction(withPlanMode(permissive, true), "write_file", { path: "a" }), "deny",
    "plan mode rules must take precedence over the user's own");
});

test("plan mode off changes nothing at all", () => {
  const p: Permissions = { version: 1, rules: [], default: "ask" };
  assert.deepEqual(withPlanMode(p, false), p);
  assert.ok(planModeRules().some((r) => r.tool === "*" && r.action === "deny"),
    "the ruleset ends in a catch-all deny");
});

test("the block reason tells the model what to do instead", async () => {
  const res = await decideApproval(
    { toolName: "write_file", input: { path: "a", content: "b" } },
    allowUI, off, true, DEFAULT_PERMISSIONS, true,
  );
  assert.equal(res.block, true);
  assert.match(res.reason ?? "", /plan mode/);
  assert.match(res.reason ?? "", /read_file/, "it should name the tools that still work");
  assert.doesNotMatch(res.reason ?? "", /permissions\.json/, "wrong reason would misdirect the model");
});

test("reading still works in plan mode, without a prompt", async () => {
  let asked = false;
  const ui = { confirm: async () => { asked = true; return false; } };
  const res = await decideApproval(
    { toolName: "read_file", input: { path: "src/a.ts" } },
    ui, { MNEMO_APPROVAL_MODE: "interactive" } as NodeJS.ProcessEnv, true, DEFAULT_PERMISSIONS, true);
  assert.deepEqual(res, {});
  assert.equal(asked, false);
});

test("the env flag and the runtime toggle agree", () => {
  assert.equal(planModeFromEnv({ MNEMO_PLAN_MODE: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(planModeFromEnv({ MNEMO_PLAN_MODE: "on" } as NodeJS.ProcessEnv), true);
  assert.equal(planModeFromEnv({ MNEMO_PLAN_MODE: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(planModeFromEnv({} as NodeJS.ProcessEnv), false);

  assert.equal(isPlanMode(), false, "off by default");
  setPlanMode(true);
  assert.equal(isPlanMode(), true);
  setPlanMode(false);
  assert.equal(isPlanMode(), false);
});
