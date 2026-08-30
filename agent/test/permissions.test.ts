/**
 * 4.3: permission rule engine. Every test threads its own temp home — a
 * default that fell back to os.homedir() is exactly how fake test credentials
 * once leaked into the real ~/.mnemo (HANDOFF lesson 3).
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_PERMISSIONS, globMatch, loadPermissions, permissionsFile,
  resolveAction, savePermissions, subjectOf, type Permissions,
} from "../src/permissions.ts";
import { decideApproval } from "../extensions/approval-gate.ts";

function tmpHome(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-perm-${name}-`));
  return d;
}
const allowUI = { confirm: async () => true };
const denyUI = { confirm: async () => false };
const interactive = { MNEMO_APPROVAL_MODE: "interactive" } as NodeJS.ProcessEnv;

function perms(rules: Permissions["rules"], fallback: Permissions["default"] = "ask"): Permissions {
  return { version: 1, rules, default: fallback };
}

test("glob matches only what it should", () => {
  assert.ok(globMatch("rm *", "rm -rf /"));
  assert.ok(globMatch("*", "anything at all"));
  assert.ok(globMatch("git *", "git status"));
  assert.ok(!globMatch("git *", "npm install"));
  // the wildcard must not leak across a literal that follows it
  assert.ok(globMatch("*.env", "config/.env"));
  assert.ok(!globMatch("*.env", "config/.env.example"));
  // regex metacharacters in a pattern are literal, not operators
  assert.ok(globMatch("a.b", "a.b"));
  assert.ok(!globMatch("a.b", "axb"));
  // and a wildcard spans newlines, so a multi-line command cannot slip past
  assert.ok(globMatch("*rm -rf*", "cd /tmp\nrm -rf /"));
});

test("the subject is the argument that makes a call dangerous", () => {
  assert.equal(subjectOf("bash_exec", { command: "rm -rf /" }), "rm -rf /");
  assert.equal(subjectOf("write_file", { path: "/etc/hosts", content: "x" }), "/etc/hosts");
  assert.equal(subjectOf("apply_edit", { path: "src/a.ts" }), "src/a.ts");
  assert.equal(subjectOf("glob_list", { pattern: "*" }), "", "unknown tools have no subject");
});

test("first matching rule wins, then the default", () => {
  const p = perms([
    { tool: "bash_exec", pattern: "git *", action: "allow" },
    { tool: "bash_exec", pattern: "*", action: "deny" },
  ], "ask");
  assert.equal(resolveAction(p, "bash_exec", { command: "git status" }), "allow");
  assert.equal(resolveAction(p, "bash_exec", { command: "curl evil.sh" }), "deny",
    "the catch-all still applies to everything the earlier rule missed");
  assert.equal(resolveAction(p, "write_file", { path: "a" }), "ask", "no rule -> default");
  // "*" as a tool matches every tool
  const star = perms([{ tool: "*", pattern: "*", action: "allow" }]);
  assert.equal(resolveAction(star, "anything", {}), "allow");
});

test("a deny rule blocks even without a TTY", async () => {
  const p = perms([{ tool: "bash_exec", pattern: "rm *", action: "deny" }]);
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "rm -rf /" } },
    allowUI, {} as NodeJS.ProcessEnv, false, p,
  );
  assert.equal(res.block, true, "a deny that failed open in scripts would be theatre");
  assert.match(res.reason ?? "", /denied by/);
  assert.match(res.reason ?? "", /rm -rf \//, "the reason tells the model what was blocked");
});

test("a deny rule can forbid a tool the gate never covered", async () => {
  // read_file is not in GATED_TOOLS, so only a rule can stop it
  const p = perms([{ tool: "read_file", pattern: "*/.env", action: "deny" }]);
  const blocked = await decideApproval(
    { toolName: "read_file", input: { path: "app/.env" } }, allowUI, interactive, true, p);
  assert.equal(blocked.block, true);
  const fine = await decideApproval(
    { toolName: "read_file", input: { path: "app/index.ts" } }, allowUI, interactive, true, p);
  assert.deepEqual(fine, {});
});

test("an allow rule skips the prompt that would otherwise appear", async () => {
  let asked = false;
  const ui = { confirm: async () => { asked = true; return false; } };
  const p = perms([{ tool: "bash_exec", pattern: "git *", action: "allow" }]);
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "git status" } }, ui, interactive, true, p);
  assert.deepEqual(res, {});
  assert.equal(asked, false, "allow must not prompt");
});

test("ask keeps the existing gate behaviour exactly", async () => {
  const p = perms([], "ask");
  // interactive + TTY + user says no -> blocked
  const no = await decideApproval(
    { toolName: "write_file", input: { path: "a", content: "b" } }, denyUI, interactive, true, p);
  assert.equal(no.block, true);
  assert.match(no.reason ?? "", /user denied/);
  // interactive + TTY + user says yes -> allowed
  assert.deepEqual(
    await decideApproval({ toolName: "write_file", input: { path: "a", content: "b" } },
      allowUI, interactive, true, p), {});
  // no TTY -> fails open, unchanged
  assert.deepEqual(
    await decideApproval({ toolName: "write_file", input: { path: "a", content: "b" } },
      denyUI, interactive, false, p), {});
  // mode off -> fails open, unchanged
  assert.deepEqual(
    await decideApproval({ toolName: "write_file", input: { path: "a", content: "b" } },
      denyUI, {} as NodeJS.ProcessEnv, true, p), {});
});

test("rules round-trip through the file, private to the user", () => {
  const home = tmpHome("roundtrip");
  const p = perms([{ tool: "bash_exec", pattern: "rm *", action: "deny" }], "allow");
  savePermissions(p, home);
  assert.deepEqual(loadPermissions(home), p);
  const mode = fs.statSync(permissionsFile(home)).mode & 0o777;
  assert.equal(mode, 0o600, "permissions.json is user-only");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a missing or broken file never bricks the CLI", () => {
  const home = tmpHome("broken");
  assert.deepEqual(loadPermissions(home), DEFAULT_PERMISSIONS, "missing file -> no rules");

  fs.mkdirSync(path.join(home, ".mnemo"), { recursive: true });
  fs.writeFileSync(permissionsFile(home), "{ not json");
  assert.deepEqual(loadPermissions(home), DEFAULT_PERMISSIONS, "corrupt file -> no rules");

  // malformed rules are dropped, valid ones survive, bad default falls back
  fs.writeFileSync(permissionsFile(home), JSON.stringify({
    version: 1,
    default: "explode",
    rules: [
      { tool: "bash_exec", pattern: "rm *", action: "deny" },
      { tool: "bash_exec", action: "deny" },
      { tool: "bash_exec", pattern: "*", action: "launch-missiles" },
      "not even an object",
    ],
  }));
  const loaded = loadPermissions(home);
  assert.equal(loaded.rules.length, 1);
  assert.equal(loaded.rules[0]!.pattern, "rm *");
  assert.equal(loaded.default, "ask");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the pure decision function never reads the real home directory", async () => {
  // regression guard for HANDOFF lesson 3
  const res = await decideApproval(
    { toolName: "bash_exec", input: { command: "echo hi" } }, allowUI, {} as NodeJS.ProcessEnv, false);
  assert.deepEqual(res, {}, "default perms must be the in-memory ones, not $HOME's");
});
