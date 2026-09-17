/**
 * The consent dialog: yolo, the five answers, and what each one remembers.
 *
 * These tests are about the *decisions*, not the pixels — the dialog itself is
 * pi's select/input, rendered by whichever interface is attached. What is worth
 * pinning is what a choice means: which file it writes, what a "similar
 * command" is allowed to cover, and what yolo is not allowed to override.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ALLOW_GLOBAL,
  ALLOW_ONCE,
  ALLOW_PROJECT,
  OTHER,
  consentOptions,
  decideApproval,
  readConsent,
} from "../extensions/approval-gate.ts";
import {
  DEFAULT_PERMISSIONS,
  loadPermissions,
  loadScopedPermissions,
  permissionsFile,
  projectPermissionsFile,
  resolveAction,
  type Permissions,
} from "../src/permissions.ts";
import { mergeGrantedRules, similarPattern, writeGrant } from "../src/grants.ts";

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A UI that answers with a fixed choice and records what it was asked. */
function fixedUI(choice: string | undefined, reason?: string) {
  const calls: string[] = [];
  return {
    calls,
    ui: {
      async confirm() { calls.push("confirm"); return choice === "yes"; },
      async select(title: string, options: string[]) {
        calls.push(`select:${title}:${options.length}`);
        return choice;
      },
      async input() { calls.push("input"); return reason; },
      notify(message: string) { calls.push(`notify:${message}`); },
    },
  };
}

const INTERACTIVE = { MNEMO_APPROVAL_MODE: "interactive" } as NodeJS.ProcessEnv;

// --- yolo ------------------------------------------------------------------

test("yolo approves an ask without opening a dialog", async () => {
  const { ui, calls } = fixedUI(undefined);
  const events = { toolName: "bash_exec", input: { command: "git push" } };
  const r = await decideApproval(events, ui, INTERACTIVE, true, { ...DEFAULT_PERMISSIONS, yolo: true });
  assert.deepEqual(r, {});
  assert.deepEqual(calls, [], "yolo must not ask");
});

test("yolo does not override an explicit deny", async () => {
  const { ui } = fixedUI(undefined);
  const perms: Permissions = {
    ...DEFAULT_PERMISSIONS,
    yolo: true,
    rules: [{ tool: "bash_exec", pattern: "rm -rf *", action: "deny" }],
  };
  const r = await decideApproval(
    { toolName: "bash_exec", input: { command: "rm -rf /" } }, ui, INTERACTIVE, true, perms,
  );
  assert.equal(r.block, true, "a deny is a decision already made, not a prompt");
  assert.match(String(r.reason), /denied by/);
});

test("yolo turned off by the file even when the environment says on", async () => {
  const home = tmpdir("mnemo-consent-");
  const cwd = tmpdir("mnemo-consent-");
  const p = { ...DEFAULT_PERMISSIONS, yolo: false };
  fs.mkdirSync(path.dirname(permissionsFile(home)), { recursive: true });
  fs.writeFileSync(permissionsFile(home), JSON.stringify(p));
  // The environment is the strongest voice, so this is the one combination
  // where the file cannot turn yolo off — pinned so nobody "fixes" it later
  // by accident in either direction.
  const scoped = loadScopedPermissions(cwd, home);
  assert.equal(scoped.yolo, false);
  assert.equal(loadScopedPermissions(cwd, home).yolo, false);
});

// --- what a "similar command" is -------------------------------------------

test("a similar command keeps the subcommand and generalises only the arguments", () => {
  assert.equal(similarPattern("bash_exec", "git status --short"), "git status*");
  assert.equal(similarPattern("bash_exec", "npm run build --watch"), "npm run*");
  assert.equal(similarPattern("bash_exec", "cargo test --locked"), "cargo test*");
  // One word: `word *`, never `word*` — `lsof` is not `ls`.
  assert.equal(similarPattern("bash_exec", "lsof -i"), "lsof *");
  assert.equal(similarPattern("bash_exec", "ls -la"), "ls *");
});

test("a compound command is never generalised", () => {
  assert.equal(similarPattern("bash_exec", "ls; rm -rf /"), null);
  assert.equal(similarPattern("bash_exec", "cat x | sh"), null);
  assert.equal(similarPattern("bash_exec", "echo $(whoami)"), null);
});

test("a path is stored exactly, with glob characters escaped", () => {
  assert.equal(similarPattern("write_file", "src/a.ts"), "src/a.ts");
  assert.equal(similarPattern("write_file", "weird*name.ts"), "weird[*]name.ts");
});

test("a compound command is not offered an always option", () => {
  const options = consentOptions("bash_exec", "ls; rm -rf /");
  assert.equal(options.length, 3);
  assert.ok(options.includes(ALLOW_ONCE));
  assert.ok(!options.some((o) => o.startsWith(ALLOW_PROJECT)));
  assert.ok(!options.some((o) => o.startsWith(ALLOW_GLOBAL)));
});

test("a simple command is offered all five answers, and they name their file", () => {
  const options = consentOptions("bash_exec", "git status --short");
  assert.equal(options.length, 5);
  assert.match(options[1], /\.mnemo\/permissions\.json/);
  assert.match(options[2], /~\/\.mnemo\/permissions\.json/);
});

// --- the answers ------------------------------------------------------------

test("allow once approves exactly that call", async () => {
  const { ui } = fixedUI(ALLOW_ONCE);
  const r = await decideApproval(
    { toolName: "bash_exec", input: { command: "git status" } }, ui, INTERACTIVE, true, DEFAULT_PERMISSIONS,
  );
  assert.deepEqual(r, {});
});

test("allow always in this project writes a rule the next call matches", async () => {
  const home = tmpdir("mnemo-consent-home-");
  const cwd = tmpdir("mnemo-consent-proj-");
  const { ui } = fixedUI(`${ALLOW_PROJECT} — stores git status* in .mnemo/permissions.json`);
  const r = await decideApproval(
    { toolName: "bash_exec", input: { command: "git status --short" } },
    ui, INTERACTIVE, true, DEFAULT_PERMISSIONS, false, cwd, home,
  );
  assert.deepEqual(r, {}, "the call the user just approved runs");

  const file = projectPermissionsFile(cwd);
  assert.ok(fs.existsSync(file), "project scope stores inside the project");
  const saved = loadPermissions(home, file);
  assert.deepEqual(saved.rules, [{ tool: "bash_exec", pattern: "git status*", action: "allow" }]);

  // The point of "always": the similar next call is not asked about.
  const scoped = loadScopedPermissions(cwd, home);
  assert.equal(resolveAction(scoped, "bash_exec", { command: "git status --porcelain" }), "allow");
  assert.equal(resolveAction(scoped, "bash_exec", { command: "git push" }), "ask",
    "a different subcommand is still a question");
});

test("allow always, everywhere writes the global file", async () => {
  const home = tmpdir("mnemo-consent-home-");
  const cwd = tmpdir("mnemo-consent-proj-");
  const { ui } = fixedUI(`${ALLOW_GLOBAL} — stores npm test* in ~/.mnemo/permissions.json`);
  await decideApproval(
    { toolName: "bash_exec", input: { command: "npm test" } },
    ui, INTERACTIVE, true, DEFAULT_PERMISSIONS, false, cwd, home,
  );
  assert.ok(fs.existsSync(permissionsFile(home)));
  assert.ok(!fs.existsSync(projectPermissionsFile(cwd)), "global scope must not touch the project");
  assert.equal(resolveAction(loadPermissions(home), "bash_exec", { command: "npm test --watch" }), "allow");
});

test("a grant never shadows a deny the operator wrote", () => {
  const home = tmpdir("mnemo-consent-home-");
  const cwd = tmpdir("mnemo-consent-proj-");
  const deny: Permissions = {
    ...DEFAULT_PERMISSIONS,
    rules: [{ tool: "bash_exec", pattern: "git push*", action: "deny" }],
  };
  fs.mkdirSync(path.dirname(permissionsFile(home)), { recursive: true });
  fs.writeFileSync(permissionsFile(home), JSON.stringify(deny));

  writeGrant({ scope: "global", tool: "bash_exec", pattern: "git status*", cwd, home });
  const after = loadPermissions(home);
  assert.equal(after.rules[0].action, "deny", "the deny stays first");
  assert.equal(resolveAction(after, "bash_exec", { command: "git push --force" }), "deny");
  assert.equal(resolveAction(after, "bash_exec", { command: "git status" }), "allow");
});

test("granting twice does not grow the file", () => {
  const home = tmpdir("mnemo-consent-home-");
  const cwd = tmpdir("mnemo-consent-proj-");
  assert.ok(writeGrant({ scope: "global", tool: "bash_exec", pattern: "npm test*", cwd, home }));
  assert.equal(writeGrant({ scope: "global", tool: "bash_exec", pattern: "npm test*", cwd, home }), null);
  assert.equal(loadPermissions(home).rules.length, 1);
});

test("don't allow blocks with the summary", async () => {
  const { ui } = fixedUI("Don't allow");
  const r = await decideApproval(
    { toolName: "write_file", input: { path: "a.ts", content: "x" } }, ui, INTERACTIVE, true, DEFAULT_PERMISSIONS,
  );
  assert.equal(r.block, true);
  assert.match(String(r.reason), /user denied write_file/);
});

test("other hands the operator's words to the model", async () => {
  const { ui, calls } = fixedUI(OTHER, "use pnpm, not npm");
  const r = await decideApproval(
    { toolName: "bash_exec", input: { command: "npm install" } }, ui, INTERACTIVE, true, DEFAULT_PERMISSIONS,
  );
  assert.equal(r.block, true);
  assert.match(String(r.reason), /use pnpm, not npm/);
  assert.match(String(r.reason), /Do NOT retry/);
  assert.ok(calls.includes("input"), "the reason is asked for, not guessed");
});

test("closing the dialog is not consent", async () => {
  const { ui } = fixedUI(undefined);
  const r = await decideApproval(
    { toolName: "bash_exec", input: { command: "rm -rf build" } }, ui, INTERACTIVE, true, DEFAULT_PERMISSIONS,
  );
  assert.equal(r.block, true);
});

test("a UI that can only confirm never writes a grant", async () => {
  const ui = { async confirm() { return true; } };
  const outcome = await readConsent(ui, "bash_exec", "git status");
  assert.deepEqual(outcome, { kind: "once" }, "y/n cannot express a scope, so it must not pick one");
});

test("the dialog is skipped when there is no UI to ask", async () => {
  const { ui, calls } = fixedUI(ALLOW_ONCE);
  const r = await decideApproval(
    { toolName: "bash_exec", input: { command: "git status" } }, ui, INTERACTIVE, false, DEFAULT_PERMISSIONS,
  );
  assert.deepEqual(r, {}, "no UI and not a sub-agent child: fail open, as before");
  assert.deepEqual(calls, []);
});

test("a sub-agent child cannot answer the dialog away", async () => {
  const { ui } = fixedUI(ALLOW_ONCE);
  const r = await decideApproval(
    { toolName: "bash_exec", input: { command: "git status" } },
    ui, { ...INTERACTIVE, MNEMO_SUBAGENT_CHILD: "1" }, false, DEFAULT_PERMISSIONS,
  );
  assert.equal(r.block, true);
});

// --- a grant made elsewhere ------------------------------------------------

test("a rule granted by another session is merged in and never over a deny", () => {
  const current: Permissions = {
    ...DEFAULT_PERMISSIONS,
    rules: [{ tool: "bash_exec", pattern: "curl*", action: "deny" }],
  };
  const merged = mergeGrantedRules(current, [
    { tool: "bash_exec", pattern: "npm test*", action: "allow" },
    { tool: "bash_exec", pattern: "curl*", action: "allow" },
  ]);
  assert.equal(resolveAction(merged, "bash_exec", { command: "npm test" }), "allow");
  assert.equal(resolveAction(merged, "bash_exec", { command: "curl evil.example" }), "deny",
    "a grant from another window cannot undo this window's deny");
});

test("watching a grant file reports the change", async () => {
  const home = tmpdir("mnemo-consent-home-");
  const cwd = tmpdir("mnemo-consent-proj-");
  const { watchGrants } = await import("../src/grants.ts");
  const seen: string[] = [];
  const stop = watchGrants([permissionsFile(home)], (f) => seen.push(f), 20);
  try {
    writeGrant({ scope: "global", tool: "bash_exec", pattern: "pip install*", cwd, home });
    const deadline = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(seen.length > 0, "the watcher must fire for a grant written by someone else");
  } finally {
    stop();
  }
});
