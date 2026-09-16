/**
 * AREA 9.2 + 9.4 — executor exit-code semantics, stdin JSON delivery, timeout,
 * arg-rewrite plumbing, and the audit trail through the real tracer (temp
 * home). Real temp scripts, injected clock — no real machine state.
 *
 * The fixtures are plain node scripts run as `node <script>`, never `#!/bin/sh`
 * stand-ins: a fixture that needs a POSIX shell takes the whole package down on
 * a machine that has none (AGENTS.md, "Test fixtures never spawn a shell").
 * Node is the one interpreter every platform has, and the contract under test
 * — an exit code in, JSON out — needs nothing else.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  blockReason, executeHook, parseResponse, resolveCommand, scopeCommand, shellArgv, timeoutMs,
  DEFAULT_HOOK_TIMEOUT_MS, type ExecRequest,
} from "../src/hooks/executor.ts";
import { findOnPath, isCmdShell, isPosixShellName, shellKindOf, resolveHookShell } from "../src/hooks/shell.ts";
import { HookAudit, auditInvocation } from "../src/hooks/audit.ts";
import { readSpans } from "../src/trace.ts";
import type { HookManifest } from "../src/hooks/types.ts";

let counter = 0;

function tmpBase(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-hooks-${name}-${counter++}-`));
}

/** The interpreter every platform has, quoted for either shell's syntax. */
const NODE = `"${process.execPath.replace(/\\/g, "/")}"`;

/** The hook command line that runs one node fixture (a program line, not a path). */
function nodeCmd(fixture: string): string {
  return `${NODE} "${fixture.replace(/\\/g, "/")}"`;
}

/** Write a fixture script; returns its absolute path. */
function script(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, `// fixture: ${name}\n${body}\n`);
  return p;
}

/** A hook body that writes one stderr line (optional) and exits with `code`. */
function exitWith(code: number, stderr = ""): string {
  return (stderr ? `process.stderr.write(${JSON.stringify(`${stderr}\n`)}); ` : "") + `process.exit(${code});`;
}

/** A hook body that answers with an exit-0 JSON response. */
function response(obj: unknown): string {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(obj))});`;
}

/** A hook body that hands back whatever it read on stdin. */
const ECHO_STDIN =
  'let buf = ""; process.stdin.on("data", (d) => { buf += d; }); ' +
  'process.stdin.on("end", () => { process.stdout.write(buf.trim()); });';

function manifest(dir: string, over: Partial<HookManifest> = {}): HookManifest {
  const file = over.file ?? path.join(dir, "hook.json");
  return { id: "t", trigger: "PreToolUse", command: "echo", ...over, file };
}

function clock(start = Date.parse("2026-03-01T12:00:00Z")) {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

test("exit 0 with no stdout allows and carries no response", async () => {
  const base = tmpBase("allow");
  try {
    const p = script(base, "ok.js", exitWith(0));
    const out = await executeHook({ hook: manifest(base, { command: nodeCmd(p) }), payload: { tool: "x" } });
    assert.equal(out.status, "allow");
    if (out.status === "allow") {
      assert.equal(out.exit, 0);
      assert.equal(out.response, null);
      assert.ok(out.durationMs >= 0);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("exit 0 with a JSON response surfaces it as the hook response", async () => {
  const base = tmpBase("resp");
  try {
    const p = script(base, "rewrite.js", response({ args: { command: "echo hi" } }));
    const out = await executeHook({ hook: manifest(base, { command: nodeCmd(p) }), payload: { tool: "bash_exec" } });
    assert.equal(out.status, "allow");
    if (out.status === "allow") {
      assert.deepEqual(out.response, { args: { command: "echo hi" } });
    }
    assert.deepEqual(parseResponse('{"a":1}'), { a: 1 });
    assert.equal(parseResponse("not json"), null);
    assert.equal(parseResponse("  "), null);
    assert.equal(parseResponse("[1,2]"), null, "array stdout is not a response object");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("exit 2 blocks with the stderr reason shown to the model", async () => {
  const base = tmpBase("block");
  try {
    const p = script(base, "deny.js", exitWith(2, "writes to src/ are frozen this week"));
    const out = await executeHook({ hook: manifest(base, { command: nodeCmd(p) }), payload: {} });
    assert.equal(out.status, "block");
    if (out.status === "block") {
      assert.ok(out.reason.includes("frozen this week"), out.reason);
      assert.ok(out.reason.startsWith("blocked by hook t"), "reason names the hook");
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("exit 2 with empty streams falls back to a generic reason", () => {
  const r = blockReason({ id: "gate", trigger: "PreToolUse", command: "x" }, "", "");
  assert.equal(r, "blocked by hook gate");
  const capped = blockReason({ id: "g", trigger: "PreToolUse", command: "x" }, "y".repeat(500), "");
  assert.ok(capped.length <= 460, "reason is capped");
});

test("exit 1 (or any non-0/2) allows and reports an error, never hangs", async () => {
  const base = tmpBase("warn");
  try {
    const p = script(base, "warn.js", exitWith(1, "nope"));
    const out = await executeHook({ hook: manifest(base, { command: nodeCmd(p) }), payload: {} });
    assert.equal(out.status, "error");
    if (out.status === "error") {
      assert.equal(out.exit, 1);
      assert.equal(out.timedOut, false);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a timeout kills the hook and allows (error, not block)", async () => {
  const base = tmpBase("timeout");
  try {
    // A hook that cannot finish on its own: it waits on a release file this
    // test never writes (and gives up after a few seconds, so a kill that
    // lands before the child is up still leaves nothing behind).
    const release = path.join(base, "release.txt");
    const p = script(
      base,
      "slow.js",
      `const fs = require("node:fs");\n` +
        `const until = Date.now() + 3000;\n` +
        // Atomics.wait sleeps without spinning: a leaked fixture must not burn
        // a core on a machine that is already loaded
        `while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < until) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }\n` +
        `process.exit(0);`,
    );
    // The deadline is armed through the injected scheduler, so THIS test
    // decides when it fires. Sleeping 120ms and hoping the child outlives it
    // is what made this flake once the suite loaded the machine down.
    let fire!: () => void;
    const pending = executeHook({
      hook: manifest(base, { command: nodeCmd(p), timeout: 9999 }),
      payload: {},
      timeoutMsOverride: 120,
      scheduleTimeout: (cb) => {
        fire = cb;
        return { cancel: () => { fire = () => {}; } };
      },
    });
    fire();
    const out = await pending;
    assert.equal(out.status, "error");
    if (out.status === "error") {
      assert.equal(out.timedOut, true);
      assert.ok(/timed out/.test(out.message), out.message);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the stdin payload is the JSON tool event, sent in full", async () => {
  const base = tmpBase("stdin");
  try {
    const p = script(base, "capture.js", ECHO_STDIN);
    const payload = { tool: "write_file", args: { path: "src/a.ts", content: "hi" } };
    const out = await executeHook({ hook: manifest(base, { command: nodeCmd(p) }), payload });
    assert.equal(out.status, "allow");
    assert.deepEqual(JSON.parse(out.status === "allow" ? out.stdout : "null"), payload);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("relative commands resolve against the manifest directory", async () => {
  const base = tmpBase("rel");
  try {
    const bin = path.join(base, "bin");
    script(bin, "rel.js", exitWith(0));
    // one word: still a path beside the manifest (the long-standing contract)
    assert.equal(resolveCommand(manifest(base, { command: "bin/rel.js" })), path.join(bin, "rel.js"));
    // a program line: the shell runs it with the manifest dir as its cwd
    const out = await executeHook({
      hook: manifest(base, { file: path.join(base, "rule.json"), command: "node bin/rel.js" }),
      payload: {},
    });
    assert.equal(out.status, "allow");
    const abs = script(base, "abs.js", exitWith(0));
    assert.equal(resolveCommand(manifest(base, { command: abs })), abs);
    assert.equal(timeoutMs(manifest(base, { timeout: 3 })), 3000);
    // 12.10: a manifest without a timeout gets a finite default, so a stuck
    // hook can never hang a tool call forever
    assert.equal(timeoutMs(manifest(base, {})), DEFAULT_HOOK_TIMEOUT_MS);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("spawn of a missing command reports an error, not a hang", async () => {
  const base = tmpBase("missing");
  try {
    const out = await executeHook({ hook: manifest(base, { command: nodeCmd(path.join(base, "nope.js")) }), payload: {} });
    assert.equal(out.status, "error");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- issue #2: which shell runs the hook -------------------------------------

test("a resolved shell says how it takes a command line, and which it is", () => {
  // posix: `<shell> -c <line>`
  assert.deepEqual(
    shellArgv({ shell: "/usr/bin/bash", kind: "posix", label: "bash", source: "hook" }, "node bin/a.js"),
    { file: "/usr/bin/bash", args: ["-c", "node bin/a.js"], verbatim: false },
  );
  // cmd: `/d /s /c "<line>"`, the extra quotes keeping an inner quoted path
  // alive through cmd's first-and-last-quote stripping
  assert.deepEqual(
    shellArgv({ shell: true, kind: "cmd", label: "cmd.exe", source: "platform-default" }, '"C:/node.exe" a.js', {
      ComSpec: "C:/Windows/system32/cmd.exe",
    }),
    { file: "C:/Windows/system32/cmd.exe", args: ["/d", "/s", "/c", '""C:/node.exe" a.js"'], verbatim: true },
  );

  // the kind comes from the NAME, not from the platform we happen to run on
  assert.equal(isCmdShell("cmd"), true);
  assert.equal(isCmdShell("C:/Windows/system32/cmd.exe"), true);
  assert.equal(isCmdShell("/bin/sh"), false);
  assert.equal(isPosixShellName("bash"), true);
  assert.equal(isPosixShellName("C:/Program Files/Git/bin/bash.exe"), true);
  assert.equal(isPosixShellName("cmd"), false);
  assert.equal(shellKindOf("/bin/sh"), "posix");
  assert.equal(shellKindOf("C:/Windows/system32/cmd.exe"), "cmd");
  assert.equal(findOnPath("surely-not-a-real-binary-xyz"), undefined);
});

test("resolveHookShell: a hook's own shell wins over the platform default", () => {
  const base = tmpBase("shell-choice");
  try {
    // No MNEMO_SHELL, no pi settings in this home: the platform decides.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: base };
    // an explicit interpreter path is taken as given (it is a `-c` shell)
    const own = resolveHookShell({ id: "i", trigger: "PreToolUse", command: "x", shell: process.execPath }, env, base);
    assert.equal(own.shell, process.execPath);
    assert.equal(own.kind, "posix");
    assert.equal(own.source, "hook", "the manifest's own field, not the machine");
    // and `cmd` means cmd.exe, whichever platform default applies
    const cmd = resolveHookShell({ id: "c", trigger: "PreToolUse", command: "x", shell: "cmd" }, env, base);
    assert.equal(cmd.shell, "cmd.exe");
    assert.equal(cmd.kind, "cmd");
    // with nothing declared, the platform default is what every other tool uses
    const dflt = resolveHookShell({ id: "d", trigger: "PreToolUse", command: "x" }, env, base);
    assert.equal(dflt.source, "platform-default");
    assert.equal(dflt.kind, process.platform === "win32" ? "cmd" : "posix");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a hook naming a shell that is not there is an audited error, not a crash", async () => {
  const base = tmpBase("missing-shell");
  try {
    const out = await executeHook({
      hook: manifest(base, { command: "echo hi", shell: path.join(base, "no-such-cmd.exe") }),
      payload: {},
    });
    assert.equal(out.status, "error");
    const msg = out.status === "error" ? out.message : "";
    assert.match(msg, /could not resolve a shell/);
    assert.match(msg, /does not exist/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a configured shell that does not exist is reported, never silently skipped", async () => {
  const base = tmpBase("bogus-shell");
  try {
    const bogus = path.join(base, "no-such-shell.exe");
    const out = await executeHook({
      hook: manifest(base, { command: "echo hi" }),
      payload: {},
      env: { ...process.env, MNEMO_SHELL: bogus, HOME: base },
    });
    assert.equal(out.status, "error");
    const msg = out.status === "error" ? out.message : "";
    assert.match(msg, /could not resolve a shell/);
    assert.match(msg, /MNEMO_SHELL points at a shell that does not exist/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- audit (9.4) -------------------------------------------------------------

test("every invocation lands as a redacted span in the dated log file", () => {
  const home = tmpBase("audit");
  const c = clock();
  try {
    const audit = new HookAudit({ home, now: c.now });
    auditInvocation(audit, {
      hook: "gate", scope: "project", trigger: "PreToolUse", tool: "write_file",
      matched: true, command: "./bin/gate.sh", exit: 2, duration_ms: 9, block: true,
      reason: "denied: OPENAI_API_KEY=sk-abc...1234 leaked",
    });
    const spans = readSpans(home);
    assert.equal(spans.length, 1);
    const s = spans[0]!;
    assert.equal(s.kind, "event");
    assert.equal(s.name, "hook");
    assert.equal(s.attrs.hook, "gate");
    assert.equal(s.attrs.scope, "project");
    assert.equal(s.attrs.exit, 2);
    assert.equal(s.attrs.block, true);
    assert.ok(!String(s.attrs.reason).includes("sk-abc...mnop"), "secret-shaped reason is redacted");
    assert.ok(String(s.attrs.reason).includes("denied:"), "the rest of the reason survives");
    assert.equal(s.duration_ms, 0, "point event");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the audit file only appears once a hook actually runs", () => {
  const home = tmpBase("audit-lazy");
  try {
    const audit = new HookAudit({ home });
    assert.deepEqual(readSpans(home), [], "no writes before the first invocation");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("combined: a blocking hook against a temp tree writes its audit row", async () => {
  const base = tmpBase("combined");
  try {
    const home = path.join(base, "home");
    const p = script(base, "deny.js", exitWith(2, "frozen"));
    const out = await executeHook({
      hook: manifest(base, { id: "freeze", command: nodeCmd(p) }),
      payload: { tool: "write_file" },
    });
    assert.equal(out.status, "block");
    const audit = new HookAudit({ home });
    auditInvocation(audit, {
      hook: "freeze", trigger: "PreToolUse", tool: "write_file", matched: true,
      command: "deny.js", exit: 2, duration_ms: out.durationMs, block: true,
      reason: out.status === "block" ? out.reason : "",
    });
    const spans = readSpans(home);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.attrs.hook, "freeze");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
// --- 12.10 (41ab8d40): scope confinement -----------------------------------

test("a relative command that escapes the manifest dir is refused before running", async () => {
  const base = tmpBase("escape");
  try {
    const outside = tmpBase("outside");
    try {
      const marker = path.join(outside, "escaped-marker.txt");
      script(outside, "evil.js", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
      const rel = path.relative(path.dirname(base), outside);
      const out = await executeHook({
        hook: manifest(base, { command: path.join("..", rel, "evil.js") }),
        payload: {},
      });
      assert.equal(out.status, "error");
      const msg = out.status === "error" ? out.message : "";
      assert.match(msg, /refused/);
      assert.match(msg, /outside the hook's directory/);
      assert.ok(!fs.existsSync(marker), "the escaping command must never run");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a relative path among the arguments may not escape either", async () => {
  const base = tmpBase("escape-arg");
  try {
    const outside = tmpBase("outside-arg");
    try {
      const marker = path.join(outside, "ran.txt");
      script(outside, "evil.js", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
      // the shell resolves `..\…\evil.js` against the manifest dir, so it
      // escapes exactly like a relative program would
      const out = await executeHook({
        hook: manifest(base, { command: `node ${path.relative(base, path.join(outside, "evil.js"))}` }),
        payload: {},
      });
      assert.equal(out.status, "error");
      const msg = out.status === "error" ? out.message : "";
      assert.match(msg, /outside the hook's directory/);
      assert.ok(!fs.existsSync(marker), "the escaping argument must never run");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("scopeCommand: plain .. escapes refused; absolute and inside-relative pass", () => {
  const base = tmpBase("scope");
  try {
    assert.throws(() => scopeCommand(manifest(base, { command: "../../evil.sh" })),
      /outside the hook's directory/);
    const abs = script(base, "ok.js", exitWith(0));
    assert.equal(scopeCommand(manifest(base, { command: abs })), abs,
      "an explicit absolute path is operator intent and survives");
    assert.equal(scopeCommand(manifest(base, { command: "bin/fine.sh" })),
      path.join(base, "bin", "fine.sh"), "relative commands inside the manifest dir pass");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a symlinked subdirectory that points outside is refused (canonicalized)", async () => {
  const base = tmpBase("symlink-escape");
  try {
    const outside = tmpBase("symlink-target");
    try {
      script(outside, "evil.js", exitWith(2));
      fs.symlinkSync(outside, path.join(base, "link"));
      const out = await executeHook({
        hook: manifest(base, { command: "link/evil.js" }),
        payload: {},
      });
      assert.equal(out.status, "error");
      const msg = out.status === "error" ? out.message : "";
      assert.match(msg, /outside the hook's directory/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
