/**
 * AREA 9.1 — matcher + scope resolution + registry. All temp dirs, no real
 * machine state (HANDOFF §6.3). Deterministic: no streams, no timers.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  globToRegExp, matchPath, matchTool, matchesHook, toolPathArg,
} from "../src/hooks/matcher.ts";
import {
  loadHooks, scanHookDir, parseHookFile, globalHookRoot, userHookRoot, projectHookRoot,
  type ScanOptions,
} from "../src/hooks/scanner.ts";
import { HookRegistry, loadDisabled, saveDisabled, statePath } from "../src/hooks/registry.ts";
import { parseManifest, SCOPES } from "../src/hooks/types.ts";

// --- tiny fixture helpers ---------------------------------------------------

let counter = 0;

interface World {
  home: string;
  project: string;
  userRoot: string;
  globalRoot: string;
  projectRoot: string;
}

function world(): World {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-hooks-${counter++}-`));
  const home = path.join(base, "home");
  const project = path.join(base, "repo");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return {
    home, project,
    userRoot: userHookRoot(home),
    globalRoot: globalHookRoot(home),
    projectRoot: projectHookRoot(project),
  };
}

const opts = (w: World): ScanOptions => ({ project: w.project, home: w.home });

function writeManifest(dir: string, name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
}

function cleanup(w: World): void {
  fs.rmSync(path.dirname(w.project === "" ? w.home : w.home), { recursive: true, force: true });
  fs.rmSync(w.home, { recursive: true, force: true });
  fs.rmSync(w.project, { recursive: true, force: true });
}

// --- matcher: tool regex + path glob ----------------------------------------

test("tool matcher is a regex, and a broken one fails closed", () => {
  assert.equal(matchTool("write_file", "write|apply"), true);
  assert.equal(matchTool("read_file", "write|apply"), false);
  assert.equal(matchTool("bash_exec", undefined), true, "no pattern matches any tool");
  assert.equal(matchTool("bash_exec", "("), false, "broken regex matches nothing");
});

test("glob engine: * and ? stay inside one path segment, ** crosses", () => {
  assert.equal(matchPath("src/a.ts", "src/**"), true);
  assert.equal(matchPath("src/sub/b.ts", "src/**"), true);
  assert.equal(matchPath("src/a.ts", "*.ts"), false, "single * never crosses /");
  assert.equal(matchPath("a.ts", "*.ts"), true);
  assert.equal(matchPath("b/a.ts", "**.ts"), true, "** crosses separators");
  assert.equal(matchPath("a.tsx", "*.ts"), false, "exact anchoring, no prefix drift");
  assert.equal(matchPath("a/b/c", "**"), true);
  assert.equal(matchPath("src/a.ts", "**/*.ts"), true);
  assert.equal(matchPath("a/b.ts", "src/**"), false);
});

test("broken-looking globs degrade to literals instead of throwing", () => {
  const r = globToRegExp("[");
  assert.ok(r instanceof RegExp);
  assert.equal(r.test("["), true, "the bracket is escaped to a literal, not a class");
  assert.equal(r.test("x"), false);
});

test("path matcher requires a path-ish argument in the tool call", () => {
  assert.equal(toolPathArg({ path: "src/a.ts" }), "src/a.ts");
  assert.equal(toolPathArg({ command: "ls" }), undefined, "no path arg -> no candidate");
  assert.equal(matchesHook({ toolName: "write_file", input: { path: "src/a.ts" } }, { path: "src/**" }), true);
  assert.equal(matchesHook({ toolName: "bash_exec", input: { command: "ls" } }, { path: "src/**" }), false,
    "a path-scoped hook does NOT run against a tool call that has no path");
  assert.equal(matchesHook({ toolName: "read_file", input: { path: "test/b.ts" } }, { path: "src/**" }), false);
  assert.equal(matchesHook({ toolName: "read_file", input: { path: "x" } }, {}), true, "empty matcher matches all");
});

// --- scanner: manifest parsing and per-dir scanning --------------------------

test("a malformed manifest is rejected, not half-run", () => {
  assert.equal(parseManifest({ id: "x", trigger: "PreToolUse", command: "c" })!.id, "x");
  assert.equal(parseManifest({ id: "", trigger: "PreToolUse", command: "c" }), null);
  assert.equal(parseManifest({ id: "x", trigger: "Nope", command: "c" }), null);
  assert.equal(parseManifest({ id: "x", trigger: "PreToolUse", command: "  " }), null);
  assert.equal(parseManifest({ id: "x", trigger: "PreToolUse", command: "c", timeout: -1 }), null);
  assert.equal(parseManifest({ id: "x", trigger: "PreToolUse", command: "c", matcher: { path: 4 } }), null);
  assert.equal(parseManifest("nope"), null);
  assert.equal(parseManifest({ id: "x", trigger: "PostToolUse", command: "c", on: { audit: false } })!.on?.audit, false);
});

test("scanHookDir reads only hook manifests, ignoring state files and non-json", () => {
  const w = world();
  try {
    writeManifest(w.userRoot, "a.json", { id: "a", trigger: "PreToolUse", command: "echo a" });
    writeManifest(w.userRoot, "state.json", { disabled: ["a"] }); // no trigger -> ignored
    writeManifest(w.userRoot, "hook-state.json", { disabled: ["a"] }); // reserved name
    fs.writeFileSync(path.join(w.userRoot, "note.txt"), "hello");
    fs.mkdirSync(path.join(w.userRoot, "bin")); // subdirs are not manifests
    const hooks = scanHookDir(w.userRoot);
    assert.deepEqual(hooks.map((h) => h.id), ["a"]);
  } finally {
    cleanup(w);
  }
});

// --- scope resolution: precedence + scoped-then-id order ---------------------

test("project overrides user overrides global for the same id", () => {
  const w = world();
  try {
    const mk = (dir: string, id: string, extra: Record<string, unknown> = {}) =>
      writeManifest(dir, `${id}.json`, { id, trigger: "PreToolUse", command: "echo", ...extra });
    mk(w.globalRoot, "police", { matcher: { tool: "bash_exec" }, on: { block: true } });
    mk(w.userRoot, "police", { matcher: { tool: "bash_exec" }, on: { block: true }, description: "user copy" });
    mk(w.projectRoot, "police", { command: "echo project", description: "project copy" });
    mk(w.projectRoot, "zzz", {});
    mk(w.userRoot, "aaa", {});
    mk(w.globalRoot, "mmm", {});

    const hooks = loadHooks(opts(w));
    assert.deepEqual(hooks.map((h) => `${h.scope}:${h.id}`),
      ["project:police", "project:zzz", "user:aaa", "global:mmm"],
      "one row per id, project first, then user, then global; id-sorted within scope");
    const police = hooks.find((h) => h.id === "police");
    assert.ok(police, "project copy present");
    assert.equal(police.description, "project copy", "the project copy wins");
    assert.equal(police.command, "echo project");
  } finally {
    cleanup(w);
  }
});

test("a disabled project hook does not shadow a lower-scope copy of the same id", () => {
  const w = world();
  try {
    writeManifest(w.projectRoot, "p.json", { id: "p", trigger: "PreToolUse", command: "echo", enabled: false });
    writeManifest(w.userRoot, "p.json", { id: "p", trigger: "PreToolUse", command: "echo user" });
    const hooks = loadHooks(opts(w));
    assert.deepEqual(hooks.map((h) => `${h.scope}:${h.id}`), ["user:p"], "user copy surfaces");
  } finally {
    cleanup(w);
  }
});

test("enabled:false inside a manifest removes that hook", () => {
  const w = world();
  try {
    writeManifest(w.userRoot, "quiet.json", { id: "quiet", trigger: "TurnEnd", command: "echo", enabled: false });
    writeManifest(w.userRoot, "loud.json", { id: "loud", trigger: "TurnEnd", command: "echo" });
    assert.deepEqual(loadHooks(opts(w)).map((h) => h.id), ["loud"]);
  } finally {
    cleanup(w);
  }
});

// --- registry: disable/enable persistence ------------------------------------

test("disable persists to hook-state.json and stops the hook from loading", () => {
  const w = world();
  try {
    writeManifest(w.projectRoot, "gate.json", { id: "gate", trigger: "PreToolUse", command: "echo" });
    writeManifest(w.userRoot, "other.json", { id: "other", trigger: "TurnEnd", command: "echo" });
    const reg = new HookRegistry({ scan: opts(w) });
    assert.equal(reg.hooks().length, 2);

    const ref = reg.disable("gate");
    assert.ok(ref, "disable resolves the effective scope");
    assert.equal(ref.key, "project:gate");
    assert.deepEqual(reg.hooks().map((h) => h.id), ["other"]);

    // a fresh registry (new process) reads the same state file
    const reg2 = new HookRegistry({ scan: opts(w) });
    assert.deepEqual(reg2.hooks().map((h) => h.id), ["other"], "disable survived a registry reload");
    assert.ok(fs.existsSync(statePath(w.home)));
    assert.deepEqual(loadDisabled(w.home), new Set(["project:gate"]));

    assert.equal(reg2.enable("project:gate"), true);
    assert.deepEqual(reg2.hooks().map((h) => h.id).sort(), ["gate", "other"]);
  } finally {
    cleanup(w);
  }
});

test("disable with a bare id that exists in two scopes targets the effective one", () => {
  const w = world();
  try {
    writeManifest(w.projectRoot, "x.json", { id: "x", trigger: "PreToolUse", command: "echo p" });
    writeManifest(w.userRoot, "x.json", { id: "x", trigger: "PreToolUse", command: "echo u" });
    const reg = new HookRegistry({ scan: opts(w) });
    assert.equal(reg.hooks().filter((h) => h.id === "x").length, 1, "one effective copy");
    const ref = reg.disable("x");
    assert.notEqual(ref, false, "disable found the effective copy");
    assert.equal(ref !== false ? ref.key : "", "project:x");
    const live = reg.byId("x");
    assert.ok(live, "a live copy still exists");
    assert.equal(live.scope, "user", "disabling the project copy surfaces the user copy");
    const effective = reg.effective("x");
    assert.ok(effective, "user copy still resolves");
    assert.equal(effective.scope, "user");
  } finally {
    cleanup(w);
  }
});

test("saveDisabled round-trips and writes mode 0600", () => {
  const w = world();
  try {
    const set = new Set(["user:a", "project:b"]);
    saveDisabled(w.home, set);
    assert.deepEqual(loadDisabled(w.home), set);
    const mode = fs.statSync(statePath(w.home)).mode & 0o777;
    assert.equal(mode, 0o600, "state file carries user-only permissions");
  } finally {
    cleanup(w);
  }
});

test("scope roots follow the spec paths", () => {
  const w = world();
  try {
    assert.equal(projectHookRoot(w.project), path.join(w.project, ".mnemo", "hooks"));
    assert.equal(userHookRoot(w.home), path.join(w.home, ".mnemo", "hooks"));
    assert.equal(globalHookRoot(w.home), path.join(w.home, ".config", "mnemo", "hooks"));
  } finally {
    cleanup(w);
  }
});

test("parseHookFile is a thin disk wrapper over parseManifest", () => {
  const w = world();
  try {
    writeManifest(w.userRoot, "ok.json", { id: "ok", trigger: "SessionStart", command: "echo" });
    const byDir = scanHookDir(w.userRoot).find((h) => h.id === "ok");
    const direct = parseHookFile(path.join(w.userRoot, "ok.json"));
    assert.ok(direct && byDir, "manifest parses");
    assert.equal(direct.id, "ok");
    assert.equal(direct.trigger, "SessionStart");
    assert.equal(direct.file, path.join(w.userRoot, "ok.json"));
    assert.equal(byDir.file, direct.file);
  } finally {
    cleanup(w);
  }
});

test("SCOPES exposes the resolution order", () => {
  assert.deepEqual([...SCOPES], ["project", "user", "global"]);
});