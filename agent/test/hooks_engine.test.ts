/**
 * AREA 9.3 + 9.5 — the pi wiring (attachHooks with a fake PiLike) and the
 * /hook command flows. Real temp scripts; arrays-of-handlers fake pi; no real
 * machine state, no timers (HANDOFF §6.3).
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HookEngine, attachHooks, type PiLike } from "../src/hooks/engine.ts";
import { HookAudit } from "../src/hooks/audit.ts";
import { readSpans } from "../src/trace.ts";
import { runHookCommand, type HookCommandCtx } from "../src/hooks/commands.ts";
import { projectHookRoot, userHookRoot } from "../src/hooks/scanner.ts";

let counter = 0;

interface World { base: string; home: string; project: string; }

function world(): World {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-hooks-${counter++}-`));
  const home = path.join(base, "home");
  const project = path.join(base, "repo");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { base, home, project };
}

const sh = (body: string) => `#!/bin/sh\n${body}\n`;

function script(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

function writeManifest(dir: string, name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
}

interface FakePi extends PiLike {
  handlers: Record<string, Array<(...args: any[]) => any>>;
  emit(name: string, ev: any, ctx?: any): Promise<any[]>;
}

function fakePi(): FakePi {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  return {
    handlers,
    on(name: string, h: (...args: any[]) => any) { (handlers[name] ??= []).push(h); },
    async emit(name: string, ev: any, ctx?: any): Promise<any[]> {
      const out: any[] = [];
      for (const h of handlers[name] ?? []) out.push(await h(ev, ctx));
      return out;
    },
  };
}

/** Engine wired to a fake pi, project = temp repo, audit -> temp home. */
function setup(w: World): { engine: HookEngine; pi: FakePi } {
  const engine = new HookEngine({ home: w.home, audit: new HookAudit({ home: w.home }) });
  const pi = fakePi();
  attachHooks(pi, engine);
  return { engine, pi };
}

// --- PreToolUse: block / allow / args rewrite --------------------------------

test("a blocking PreToolUse hook vetoes the call with its stderr reason", async () => {
  const w = world();
  try {
    const { pi } = setup(w);
    const cmd = script(w.base, "deny.sh", sh('echo "no writes to src" >&2\nexit 2'));
    writeManifest(projectHookRoot(w.project), "guard.json",
      { id: "guard", trigger: "PreToolUse", matcher: { tool: "write_file|apply_edit" }, command: cmd });
    const ev = { toolName: "write_file", toolCallId: "c1", input: { path: "src/a.ts", content: "x" } };
    const [res] = await pi.emit("tool_call", ev, { cwd: w.project });
    assert.deepEqual(res, { block: true, reason: "blocked by hook guard: no writes to src" });
    assert.deepEqual(ev.input, { path: "src/a.ts", content: "x" }, "a block never mutates input");
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("a non-matching tool sails past a matcher-having hook", async () => {
  const w = world();
  try {
    const { pi } = setup(w);
    const marker = path.join(w.base, "ran.txt");
    const cmd = script(w.base, "mark.sh", sh(`touch ${marker}\nexit 0`));
    writeManifest(projectHookRoot(w.project), "readonly.json",
      { id: "ro", trigger: "PreToolUse", matcher: { tool: "write_file", path: "src/**" }, command: cmd });
    const [res] = await pi.emit("tool_call",
      { toolName: "bash_exec", toolCallId: "c", input: { command: "ls" } }, { cwd: w.project });
    assert.equal(res, undefined, "path-scoped hook does not run for a command");
    assert.ok(!fs.existsSync(marker), "the hook script never ran");
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("PreToolUse args rewrite mutates the call in place, but only with on.modify", async () => {
  const w = world();
  try {
    const { pi, engine } = setup(w);
    const rewriter = script(w.base, "rewrite.sh", sh(`echo '{"args":{"command":"echo patched","force":true}}'`));
    writeManifest(projectHookRoot(w.project), "wrap.json",
      { id: "wrap", trigger: "PreToolUse", matcher: { tool: "bash_exec" }, command: rewriter, on: { modify: true } });
    const ev = { toolName: "bash_exec", toolCallId: "c", input: { command: "echo hi" } };
    const [res] = await pi.emit("tool_call", ev, { cwd: w.project });
    assert.equal(res, undefined, "no block");
    assert.deepEqual(ev.input, { command: "echo patched", force: true }, "args replaced in place (pi contract)");
    // without modify the response is ignored: new hook, no modify flag
    engine.registry(w.project).disable("wrap");
    writeManifest(projectHookRoot(w.project), "nowrap.json",
      { id: "nowrap", trigger: "PreToolUse", matcher: { tool: "bash_exec" }, command: rewriter, on: { audit: false } });
    const ev2 = { toolName: "bash_exec", toolCallId: "c2", input: { command: "echo hi" } };
    await pi.emit("tool_call", ev2, { cwd: w.project });
    assert.deepEqual(ev2.input, { command: "echo hi" }, "without modify the response is ignored");
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("any block veto wins; the first blocking hook in precedence order speaks", async () => {
  const w = world();
  try {
    const { engine } = setup(w);
    const projectDeny = script(w.base, "p.sh", sh("exit 2"));
    const userDeny = script(w.base, "u.sh", sh('echo "user level says no" >&2\nexit 2'));
    writeManifest(projectHookRoot(w.project), "aa.json",
      { id: "aa", trigger: "PreToolUse", command: projectDeny });
    writeManifest(userHookRoot(w.home), "bb.json",
      { id: "bb", trigger: "PreToolUse", command: userDeny });
    const dec = await engine.preToolUse({ toolName: "read_file", input: {} }, { cwd: w.project });
    assert.deepEqual(dec, { block: true, reason: "blocked by hook aa" }, "project hook speaks first");
    // disable aa, now bb is the effective blocker
    const reg = engine.registry(w.project);
    reg.disable("aa");
    const dec2 = await engine.preToolUse({ toolName: "read_file", input: {} }, { cwd: w.project });
    assert.deepEqual(dec2, { block: true, reason: "blocked by hook bb: user level says no" });
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

// --- PostToolUse -------------------------------------------------------------

test("PostToolUse can decorate the result when on.modify is set", async () => {
  const w = world();
  try {
    const { pi } = setup(w);
    const decorator = script(w.base, "deco.sh",
      sh(`echo '{"details":{"audited":true},"isError":false}'`));
    writeManifest(projectHookRoot(w.project), "audit.json",
      { id: "audit", trigger: "PostToolUse", matcher: { tool: "read_file" }, command: decorator, on: { modify: true } });
    const ev = {
      toolName: "read_file", toolCallId: "c", input: { path: "x" },
      content: [{ type: "text", text: "body" }], details: {}, isError: false,
    };
    const [patch] = await pi.emit("tool_result", ev, { cwd: w.project });
    assert.deepEqual(patch, { details: { audited: true }, isError: false });
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("PostToolUse without on.modify is observational only", async () => {
  const w = world();
  try {
    const { pi } = setup(w);
    const decorator = script(w.base, "deco.sh", sh(`echo '{"content":[{"type":"text","text":"HACKED"}]}'`));
    writeManifest(projectHookRoot(w.project), "obs.json",
      { id: "obs", trigger: "PostToolUse", command: decorator });
    const [patch] = await pi.emit("tool_result",
      { toolName: "read_file", toolCallId: "c", input: {}, content: [], details: {}, isError: false },
      { cwd: w.project });
    assert.equal(patch, undefined, "no patch without modify");
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

// --- UserPromptSubmit ---------------------------------------------------------

test("a UserPromptSubmit veto handles the prompt and notifies", async () => {
  const w = world();
  try {
    const { pi } = setup(w);
    const veto = script(w.base, "veto.sh", sh('echo "that topic is off-limits" >&2\nexit 2'));
    writeManifest(projectHookRoot(w.project), "policy.json",
      { id: "policy", trigger: "UserPromptSubmit", command: veto });
    const notified: string[] = [];
    const [res] = await pi.emit("input", { text: "tell me about X" },
      { cwd: w.project, ui: { notify: (m: string, t?: string) => notified.push(`${t}:${m}`) } });
    assert.deepEqual(res, { action: "handled" });
    assert.equal(notified.length, 1);
    assert.ok(notified[0]!.includes("off-limits"));
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("a UserPromptSubmit transformer rewrites the prompt text", async () => {
  const w = world();
  try {
    const { pi } = setup(w);
    const xform = script(w.base, "xform.sh", sh(`echo '{"prompt":"[guard] summarise exactly"}'`));
    writeManifest(projectHookRoot(w.project), "redact.json",
      { id: "redact", trigger: "UserPromptSubmit", command: xform });
    const [res] = await pi.emit("input", { text: "summarise exactly" }, { cwd: w.project });
    assert.deepEqual(res, { action: "transform", text: "[guard] summarise exactly" });
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("no matching UserPromptSubmit hook keeps the prompt", async () => {
  const w = world();
  try {
    const { pi } = setup(w);
    const [res] = await pi.emit("input", { text: "hello" }, { cwd: w.project, ui: { notify: () => {} } });
    assert.equal(res, undefined, "default = continue");
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

// --- lifecycle + audit --------------------------------------------------------

test("SessionStart runs its hooks and the 9.6 memory sync hook fires", async () => {
  const w = world();
  try {
    let synced: string | undefined;
    const engine = new HookEngine({
      home: w.home,
      audit: new HookAudit({ home: w.home }),
      onSessionStart: async (cwd) => { synced = cwd; },
    });
    const pi = fakePi();
    attachHooks(pi, engine);
    const marker = path.join(w.base, "started.txt");
    const cmd = script(w.base, "start.sh", sh(`echo "$1" >> ${marker}; exit 0`));
    writeManifest(projectHookRoot(w.project), "begin.json",
      { id: "begin", trigger: "SessionStart", command: cmd });
    await pi.emit("session_start", { reason: "startup" }, { cwd: w.project });
    assert.equal(synced, w.project, "memory sync hook called with the cwd");
    assert.ok(fs.existsSync(marker), "the lifecycle hook ran");
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("every invocation writes one redacted audit row; disabled hooks never run", async () => {
  const w = world();
  try {
    const engine = new HookEngine({ home: w.home, audit: new HookAudit({ home: w.home }) });
    const pi = fakePi();
    attachHooks(pi, engine);
    const cmd = script(w.base, "r.sh", sh("exit 0"));
    writeManifest(projectHookRoot(w.project), "a.json", { id: "a", trigger: "PreToolUse", command: cmd });
    writeManifest(projectHookRoot(w.project), "b.json", { id: "b", trigger: "PreToolUse", command: cmd });
    await pi.emit("tool_call", { toolName: "read_file", toolCallId: "c", input: {} }, { cwd: w.project });
    const spans = readSpans(w.home);
    assert.equal(spans.filter((s) => s.name === "hook").length, 2, "two hooks -> two audit rows");
    assert.ok(spans.every((s) => s.attrs.hook), "each row identifies the hook");
    const reg = engine.registry(w.project);
    reg.disable("a");
    const before = readSpans(w.home).filter((s) => s.name === "hook").length;
    await pi.emit("tool_call", { toolName: "read_file", toolCallId: "c2", input: {} }, { cwd: w.project });
    const after = readSpans(w.home).filter((s) => s.name === "hook").length;
    assert.equal(after, before + 1, "only the enabled hook ran again");
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("hooks added mid-session take effect on the next event (live reload)", async () => {
  const w = world();
  try {
    const { pi } = setup(w);
    await pi.emit("tool_call", { toolName: "bash_exec", toolCallId: "c", input: { command: "ls" } }, { cwd: w.project });
    const gate = script(w.base, "gate.sh", sh('echo live >&2\nexit 2'));
    writeManifest(userHookRoot(w.home), "late.json",
      { id: "late", trigger: "PreToolUse", matcher: { tool: "bash_exec" }, command: gate });
    const [res] = await pi.emit("tool_call",
      { toolName: "bash_exec", toolCallId: "c2", input: { command: "ls" } }, { cwd: w.project });
    assert.deepEqual(res, { block: true, reason: "blocked by hook late: live" });
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

// --- /hook command flows -------------------------------------------------------

function commandCtx(w: World, engine: HookEngine): HookCommandCtx {
  const notes: string[] = [];
  return {
    cwd: w.project,
    home: w.home,
    env: { ...process.env, HOME: w.home },
    ui: { notify: (m: string, t?: string) => notes.push(`${t ?? "info"}:${m}`) },
    engine,
  };
}

test("/hook add scaffolds a manifest + stub script into the chosen scope", async () => {
  const w = world();
  try {
    const engine = new HookEngine({ home: w.home, audit: new HookAudit({ home: w.home }) });
    const ctx = commandCtx(w, engine);
    const report = await runHookCommand(
      "add audit.store-writes --trigger PreToolUse --tool 'write_file|apply_edit' --path 'src/**' --command bin/audit.sh --scope project --timeout 5 --block --description 'audit writes'",
      ctx,
    );
    assert.ok(report.includes("audit.store-writes"), report);
    assert.ok(report.includes("stub script"), report);
    const file = path.join(projectHookRoot(w.project), "audit.store-writes.json");
    assert.ok(fs.existsSync(file), "manifest written");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(manifest.trigger, "PreToolUse");
    assert.deepEqual(manifest.matcher, { tool: "write_file|apply_edit", path: "src/**" });
    assert.equal(manifest.timeout, 5);
    assert.deepEqual(manifest.on, { block: true });
    const stub = path.join(projectHookRoot(w.project), "bin", "audit.sh");
    assert.ok(fs.existsSync(stub));
    assert.ok((fs.statSync(stub).mode & 0o111) !== 0, "stub is executable");
    // listed
    const list = await runHookCommand("list", ctx);
    assert.ok(list.includes("audit.store-writes") && list.includes("PreToolUse"));
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("/hook add refuses to overwrite without -y; -y replaces", async () => {
  const w = world();
  try {
    const engine = new HookEngine({ home: w.home, audit: new HookAudit({ home: w.home }) });
    const base = commandCtx(w, engine);
    await runHookCommand("add x --trigger TurnEnd --command bin/x.sh --scope user -y", base);
    const file = path.join(userHookRoot(w.home), "x.json");
    assert.ok(fs.existsSync(file));
    // no confirm function -> refuse
    const refused = await runHookCommand("add x --trigger TurnEnd --command bin/x.sh --scope user", base);
    assert.ok(refused.includes("not overwriting"), refused);
    // -y replaces
    const forced = await runHookCommand("add x --trigger SessionStart --command bin/x.sh --scope user -y", base);
    assert.ok(forced.includes("written"), forced);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).trigger, "SessionStart");
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("/hook test dry-runs a hook without touching the session", async () => {
  const w = world();
  try {
    const engine = new HookEngine({ home: w.home, audit: new HookAudit({ home: w.home }) });
    const ctx = commandCtx(w, engine);
    await runHookCommand("add gate --trigger PreToolUse --command bin/gate.sh --scope user -y", ctx);
    // stub exits 0 -> allow
    const allow = await runHookCommand("test gate", ctx);
    assert.ok(allow.includes("-> allow"), allow);
    // a blocking variant
    const blocky = script(w.base, "blocky.sh", sh('echo frozen >&2\nexit 2'));
    writeManifest(userHookRoot(w.home), "deny.json",
      { id: "deny", trigger: "PreToolUse", command: blocky });
    const deny = await runHookCommand("test deny bash_exec '{\"command\":\"ls\"}'", ctx);
    assert.ok(deny.includes("-> block"), deny);
    assert.ok(deny.includes("frozen"), deny);
    const missing = await runHookCommand("test nope", ctx);
    assert.ok(missing.includes("no effective hook"), missing);
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test("/hook disable + enable round-trip through the state file", async () => {
  const w = world();
  try {
    const engine = new HookEngine({ home: w.home, audit: new HookAudit({ home: w.home }) });
    const ctx = commandCtx(w, engine);
    await runHookCommand("add gate --trigger PreToolUse --command bin/gate.sh --scope user -y", ctx);
    const d = await runHookCommand("disable gate", ctx);
    assert.ok(d.includes("disabled user:gate"), d);
    const list = await runHookCommand("list", ctx);
    assert.ok(list.includes("disabled"), list);
    const e = await runHookCommand("enable user:gate", ctx);
    assert.ok(e.includes("enabled"), e);
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});
// --- 12.10 (fa244d3f): block reasons are scrubbed before the audit sink ------

test("a hook echoed secret in its block reason never reaches the audit record raw", async () => {
  const w = world();
  try {
    const SECRET = "sk-or-v1-hookechoedlongtokenthatmustneverpersist123456789";
    const cmd = script(w.base, "leak.sh", sh(`echo "DENIED leaked=${SECRET}" >&2\nexit 2`));
    writeManifest(projectHookRoot(w.project), "leaker.json",
      { id: "leaker", trigger: "PreToolUse", command: cmd });

    // narrow recording sink instead of the real tracer, so we assert on the
    // exact attrs the engine hands the audit layer
    const seen: Array<Record<string, unknown>> = [];
    const engine = new HookEngine({
      home: w.home,
      audit: { event: (_name: string, attrs: any) => { seen.push(attrs); return attrs as any; } },
    });

    const dec = await engine.preToolUse(
      { toolName: "bash_exec", toolCallId: "c", input: { command: "ls" } },
      { cwd: w.project },
    );
    assert.equal(dec?.block, true);
    const record = seen.find((s) => s.hook === "leaker" && s.block === true);
    assert.ok(record, "the invocation was audited");
    const reason = String(record!.reason ?? "");
    assert.ok(!reason.includes(SECRET), "the raw echoed secret must not be in the audit attrs");
    assert.ok(!reason.includes("sk-or-v1-hookechoed"), "the sk-or- shape must be scrubbed too");
    assert.match(reason, /\[redacted\]/, "the scrubbed reason still reads as a block");
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});
