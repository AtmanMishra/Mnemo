/**
 * AREA 9.2 + 9.4 — executor exit-code semantics, stdin JSON delivery, timeout,
 * arg-rewrite plumbing, and the audit trail through the real tracer (temp
 * home). Real temp scripts, injected clock — no real machine state.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  blockReason, executeHook, parseResponse, resolveCommand, scopeCommand, timeoutMs,
  DEFAULT_HOOK_TIMEOUT_MS, type ExecRequest,
} from "../src/hooks/executor.ts";
import { HookAudit, auditInvocation } from "../src/hooks/audit.ts";
import { readSpans } from "../src/trace.ts";
import type { HookManifest } from "../src/hooks/types.ts";

let counter = 0;

function tmpBase(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-hooks-${name}-${counter++}-`));
}

/** Write an executable fixture script; returns its absolute path. */
function script(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

const sh = (body: string) => `#!/bin/sh\n${body}\n`;

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
    const p = script(base, "ok.sh", sh("exit 0"));
    const out = await executeHook({ hook: manifest(base, { command: p }), payload: { tool: "x" } });
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
    const p = script(base, "rewrite.sh", sh(`echo '{"args":{"command":"echo hi"}}'`));
    const out = await executeHook({ hook: manifest(base, { command: p }), payload: { tool: "bash_exec" } });
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
    const p = script(base, "deny.sh", sh('echo "writes to src/ are frozen this week" >&2\nexit 2'));
    const out = await executeHook({ hook: manifest(base, { command: p }), payload: {} });
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
    const p = script(base, "warn.sh", sh("echo nope >&2\nexit 1"));
    const out = await executeHook({ hook: manifest(base, { command: p }), payload: {} });
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
    const p = script(base, "slow.sh", sh("sleep 30"));
    const out = await executeHook({
      hook: manifest(base, { command: p, timeout: 9999 }),
      payload: {},
      timeoutMsOverride: 120,
    });
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
  const got = path.join(base, "got.txt");
  try {
    const p = script(base, "capture.sh", sh(`cat > ${got}\nexit 0`));
    const payload = { tool: "write_file", args: { path: "src/a.ts", content: "hi" } };
    await executeHook({ hook: manifest(base, { command: p }), payload });
    const body = JSON.parse(fs.readFileSync(got, "utf8"));
    assert.deepEqual(body, payload);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("relative commands resolve against the manifest directory", async () => {
  const base = tmpBase("rel");
  try {
    const bin = path.join(base, "bin");
    script(bin, "rel.sh", sh("echo ok"));
    const out = await executeHook({
      hook: manifest(base, { file: path.join(base, "rule.json"), command: "bin/rel.sh" }),
      payload: {},
    });
    assert.equal(out.status, "allow");
    const abs = script(base, "abs.sh", sh("exit 0"));
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
    const out = await executeHook({ hook: manifest(base, { command: path.join(base, "nope.sh") }), payload: {} });
    assert.equal(out.status, "error");
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
      reason: "denied: OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234 leaked",
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
    assert.ok(!String(s.attrs.reason).includes("sk-abcdefghijklmnop"), "secret-shaped reason is redacted");
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
    const p = script(base, "deny.sh", sh("echo frozen >&2\nexit 2"));
    const out = await executeHook({
      hook: manifest(base, { id: "freeze", command: p }),
      payload: { tool: "write_file" },
    });
    assert.equal(out.status, "block");
    const audit = new HookAudit({ home });
    auditInvocation(audit, {
      hook: "freeze", trigger: "PreToolUse", tool: "write_file", matched: true,
      command: "deny.sh", exit: 2, duration_ms: out.durationMs, block: true,
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
      script(outside, "evil.sh", sh("touch /tmp/escaped-marker 2>/dev/null; exit 2"));
      const rel = path.relative(path.dirname(base), outside);
      const out = await executeHook({
        hook: manifest(base, { command: path.join("..", rel, "evil.sh") }),
        payload: {},
      });
      assert.equal(out.status, "error");
      const msg = out.status === "error" ? out.message : "";
      assert.match(msg, /refused/);
      assert.match(msg, /outside the hook's directory/);
      assert.ok(!fs.existsSync("/tmp/escaped-marker"), "the escaping command must never run");
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
    const abs = script(base, "ok.sh", sh("exit 0"));
    assert.equal(scopeCommand(manifest(base, { command: abs })), abs,
      "an explicit absolute path is operator intent and survives");
    assert.equal(scopeCommand(manifest(base, { command: "bin/fine.sh" })),
      path.join(base, "bin/fine.sh"), "relative commands inside the manifest dir pass");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a symlinked subdirectory that points outside is refused (canonicalized)", async () => {
  const base = tmpBase("symlink-escape");
  try {
    const outside = tmpBase("symlink-target");
    try {
      script(outside, "evil.sh", sh("exit 2"));
      fs.symlinkSync(outside, path.join(base, "link"));
      const out = await executeHook({
        hook: manifest(base, { command: "link/evil.sh" }),
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
