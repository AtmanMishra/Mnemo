/**
 * Area 5: structured traces. Every test uses its own temp home and a fake
 * clock, so nothing here writes to the developer's real ~/.mnemo/logs.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  REDACTED, Tracer, enabled, envSecrets, formatTree, levelFromEnv, logFile,
  pruneOldLogs, readSpans, redact, redactString, sessionsOf, type Span,
} from "../src/trace.ts";
import {
  PARENT_SESSION_ENV, PARENT_SPAN_ENV, attachTracing, childTraceEnv,
  outputSize, summarizeArgs,
} from "../extensions/tracing.ts";

function tmpHome(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-trace-${name}-`));
}

/** A clock that only moves when a test says so. */
function clock(start = Date.parse("2026-03-01T12:00:00Z")) {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

function fakePi() {
  const handlers: Record<string, any[]> = {};
  return {
    handlers,
    on(event: string, fn: any) { (handlers[event] ??= []).push(fn); },
    emit(event: string, payload: any) { for (const h of handlers[event] ?? []) h(payload); },
  };
}

// --- 5.1 spans -------------------------------------------------------------

test("spans nest, and land in a dated file as JSONL", () => {
  const home = tmpHome("spans");
  const c = clock();
  const tracer = new Tracer({ home, session: "s1", level: "info", now: c.now });

  const endSession = tracer.start("session", "session");
  c.tick(5);
  const endTool = tracer.start("tool", "bash_exec", { args: { command: "ls" } });
  c.tick(20);
  endTool({ ok: true, attrs: { output_bytes: 42 } });
  c.tick(5);
  endSession();

  const spans = readSpans(home);
  assert.equal(spans.length, 2);
  const tool = spans.find((s) => s.name === "bash_exec")!;
  const session = spans.find((s) => s.name === "session")!;
  assert.equal(tool.parent_id, session.id, "the tool nests under the session");
  assert.equal(tool.duration_ms, 20);
  assert.equal(session.duration_ms, 30);
  assert.equal(tool.attrs.output_bytes, 42);
  assert.ok(fs.existsSync(logFile(home, new Date(c.now()))), "written to today's file");

  // and every line is valid JSON on its own
  const raw = fs.readFileSync(logFile(home, new Date(c.now())), "utf8").trim().split("\n");
  for (const line of raw) JSON.parse(line);
  fs.rmSync(home, { recursive: true, force: true });
});

test("level off writes nothing at all", () => {
  const home = tmpHome("off");
  const tracer = new Tracer({ home, session: "s", level: "off" });
  tracer.start("tool", "x")();
  tracer.event("y");
  assert.deepEqual(readSpans(home), []);
  fs.rmSync(home, { recursive: true, force: true });

  assert.equal(levelFromEnv({ MNEMO_LOG_LEVEL: "debug" } as NodeJS.ProcessEnv), "debug");
  assert.equal(levelFromEnv({ MNEMO_LOG_LEVEL: "nonsense" } as NodeJS.ProcessEnv), "info");
  assert.equal(levelFromEnv({} as NodeJS.ProcessEnv), "info");
  assert.equal(enabled("debug", "info"), false);
  assert.equal(enabled("error", "info"), true);
  assert.equal(enabled("error", "off"), false);
});

test("tracing never throws, even when the log cannot be written", () => {
  // a file where the directory should be: appendFileSync will fail
  const home = tmpHome("unwritable");
  fs.mkdirSync(path.join(home, ".mnemo"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mnemo", "logs"), "not a directory");
  const tracer = new Tracer({ home, session: "s", level: "info" });
  assert.doesNotThrow(() => tracer.start("tool", "x")({ ok: true }));
  fs.rmSync(home, { recursive: true, force: true });
});

// --- 5.7 redaction ---------------------------------------------------------

test("secrets never reach disk", () => {
  const secrets = ["hunter2-the-real-key"];
  assert.equal(redactString("Bearer sk-abcd1234efgh5678", []), `Bearer ${REDACTED}`);
  assert.equal(redactString("token ghp_012345678901234567890123456789", []), `token ${REDACTED}`);
  assert.equal(redactString("aws AKIAIOSFODNN7EXAMPLE here", []), `aws ${REDACTED} here`);
  assert.equal(redactString("value is hunter2-the-real-key", secrets), `value is ${REDACTED}`);
  assert.equal(redactString("nothing secret here", secrets), "nothing secret here");

  // a key whose NAME says secret goes whatever its value looks like
  const out = redact({
    api_key: "plainlooking", Authorization: "x", command: "curl -H 'k: sk-abcd1234efgh'",
    nested: { password: "p", note: "hunter2-the-real-key" }, count: 3,
  }, secrets);
  assert.equal(out.api_key, REDACTED);
  // a token COUNT is not a token: over-redaction makes traces useless
  assert.deepEqual(redact({ tokens_in: 120, tokens_out: 45, access_token: "x" }, []),
    { tokens_in: 120, tokens_out: 45, access_token: REDACTED });
  assert.equal(out.Authorization, REDACTED);
  assert.match(String(out.command), /\[redacted\]/);
  assert.equal((out.nested as any).password, REDACTED);
  assert.equal((out.nested as any).note, REDACTED, "nested strings are scanned too");
  assert.equal(out.count, 3, "non-secrets are left alone");
});

test("the user's real environment values are redacted by value", () => {
  const env = { OPENROUTER_API_KEY: "or-secret-value-123", PATH: "/usr/bin" } as NodeJS.ProcessEnv;
  const secrets = envSecrets(env);
  assert.deepEqual(secrets, ["or-secret-value-123"]);
  assert.equal(redactString("used or-secret-value-123 here", secrets), `used ${REDACTED} here`);
  assert.ok(!envSecrets({ SHORT_TOKEN: "abc" } as NodeJS.ProcessEnv).length,
    "a value too short to be a key is not treated as one");
});

// --- 12.8 (2fefd9ce): URL-embedded tokens and sk-or-/tvly- shapes ----------

test("URL query params named like secrets have their values scrubbed", () => {
  assert.equal(
    redactString("curl 'https://api.example.com/data?api_key=sk-abc123&count=5'", []),
    "curl 'https://api.example.com/data?api_key=[redacted]&count=5'",
  );
  assert.equal(
    redactString("https://h.example.com/x?access_token=aaa.bbb.ccc&next=y", []),
    "https://h.example.com/x?access_token=[redacted]&next=y",
  );
  assert.equal(
    redactString("https://h.example.com/1?secret=supersecret123&token=tok987", []),
    "https://h.example.com/1?secret=[redacted]&token=[redacted]",
  );
  assert.equal(redactString("https://h.example.com/x?key=plain-enough", []),
    "https://h.example.com/x?key=[redacted]", "'key' alone is a query secret too");
  assert.equal(redactString("https://h.example.com/x?q=search+term", []),
    "https://h.example.com/x?q=search+term", "innocent params survive");
});

test("credentials embedded in a URL userinfo are scrubbed", () => {
  assert.equal(
    redactString("fetch https://admin:hunter2@internal.example.com/x", []),
    "fetch https://[redacted]@internal.example.com/x",
  );
});

test("sk-or- and tvly- key shapes are scrubbed even outside URLs", () => {
  assert.equal(
    redactString("export OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", []),
    `export OPENROUTER_API_KEY=${REDACTED}`,
  );
  assert.equal(
    redactString("tavily key tvly-12345678901234567890 used", []),
    `tavily key ${REDACTED} used`,
  );
});

test("URL-embedded tokens are scrubbed in a written span too", () => {
  const home = tmpHome("redact-url");
  const tracer = new Tracer({ home, session: "s", level: "info" });
  tracer.start("tool", "web_fetch", {
    args: { url: "https://api.x.com/?api_key=sk-or-v1-abcde12345&token=tvly-1234567890abc" },
  })({ ok: true });
  const raw = fs.readFileSync(logFile(home), "utf8");
  assert.doesNotMatch(raw, /sk-or-v1-abcde12345/, "embedded key must not reach disk");
  assert.doesNotMatch(raw, /tvly-1234567890abc/, "tvly token must not reach disk");
  assert.match(raw, /\[redacted\]/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a written span is redacted, not just the rendering", () => {
  const home = tmpHome("redact-disk");
  const tracer = new Tracer({ home, session: "s", level: "info" });
  tracer.start("tool", "bash_exec", { command: "curl -H 'Authorization: sk-livekey123456'" })({ ok: true });
  const raw = fs.readFileSync(logFile(home), "utf8");
  assert.doesNotMatch(raw, /sk-livekey123456/, "the raw file must not contain the key");
  assert.match(raw, /\[redacted\]/);
  fs.rmSync(home, { recursive: true, force: true });
});

// --- 5.7 rotation ----------------------------------------------------------

test("logs older than the window are pruned, newer ones kept", () => {
  const home = tmpHome("prune");
  const dir = path.join(home, ".mnemo", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse("2026-03-20T00:00:00Z");
  for (const d of ["2026-03-01", "2026-03-18", "2026-03-20"]) {
    fs.writeFileSync(path.join(dir, `${d}.jsonl`), "");
  }
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");

  const removed = pruneOldLogs(home, 7, now);
  assert.deepEqual(removed, ["2026-03-01.jsonl"]);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ["2026-03-18.jsonl", "2026-03-20.jsonl", "notes.txt"],
    "only dated log files are candidates for pruning");

  assert.deepEqual(pruneOldLogs(home, 0, now), [], "retention 0 disables pruning");
  fs.rmSync(home, { recursive: true, force: true });
});

// --- 5.2/5.3 spans from pi events -----------------------------------------

test("tool calls and model round trips become spans", () => {
  const home = tmpHome("events");
  const c = clock();
  const tracer = new Tracer({ home, session: "s2", level: "info", now: c.now });
  const pi = fakePi();
  const handles = attachTracing(pi, tracer, {} as NodeJS.ProcessEnv);

  pi.emit("turn_start", {});
  c.tick(10);
  pi.emit("tool_call", { toolCallId: "t1", toolName: "bash_exec", input: { command: "ls -la" } });
  c.tick(30);
  pi.emit("tool_result", { toolCallId: "t1", toolName: "bash_exec", result: "a".repeat(500) });
  c.tick(5);
  pi.emit("turn_end", {
    message: {
      provider: "opencode-go", model: "ox-alpha-free", stopReason: "stop",
      usage: { input: 120, output: 45, cost: { total: 0 } },
    },
  });
  handles.finish();

  const spans = readSpans(home);
  const tool = spans.find((s) => s.kind === "tool")!;
  assert.equal(tool.name, "bash_exec");
  assert.equal(tool.duration_ms, 30);
  assert.equal(tool.ok, true);
  assert.equal(tool.attrs.output_bytes, 500);
  assert.deepEqual(tool.attrs.args, { command: "ls -la" });

  const llm = spans.find((s) => s.kind === "llm")!;
  assert.equal(llm.attrs.provider, "opencode-go");
  assert.equal(llm.attrs.model, "ox-alpha-free");
  assert.equal(llm.attrs.tokens_in, 120);
  assert.equal(llm.attrs.tokens_out, 45);
  assert.equal(llm.attrs.stop_reason, "stop");
  assert.equal(llm.duration_ms, 45);

  assert.equal(tool.parent_id, llm.id, "the tool call nests inside the round trip");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a failed tool is marked failed, and an unfinished one still closes", () => {
  const home = tmpHome("failures");
  const tracer = new Tracer({ home, session: "s3", level: "info" });
  const pi = fakePi();
  const handles = attachTracing(pi, tracer, {} as NodeJS.ProcessEnv);

  pi.emit("tool_call", { toolCallId: "t1", toolName: "bash_exec", input: {} });
  pi.emit("tool_result", { toolCallId: "t1", isError: true, result: "boom" });
  pi.emit("tool_call", { toolCallId: "t2", toolName: "write_file", input: {} });
  handles.finish(); // t2 never got a result

  const spans = readSpans(home);
  assert.equal(spans.find((s) => s.name === "bash_exec")!.ok, false);
  const orphan = spans.find((s) => s.name === "write_file")!;
  assert.equal(orphan.ok, false);
  assert.equal(orphan.attrs.unfinished, true, "a span must never be left open");
  fs.rmSync(home, { recursive: true, force: true });
});

test("arguments are summarised, never stored whole", () => {
  const out = summarizeArgs({
    command: "x".repeat(500), items: [1, 2, 3], nested: { a: 1 }, n: 7, flag: true,
  });
  assert.ok(String(out.command).length < 200, "a long string is truncated");
  assert.match(String(out.command), /500 chars/);
  assert.equal(out.items, "[3 items]");
  assert.equal(out.nested, "{…}");
  assert.equal(out.n, 7);
  assert.equal(out.flag, true);

  assert.equal(outputSize("abc"), 3);
  assert.equal(outputSize({ a: 1 }), 7, '{"a":1}');
  assert.equal(outputSize(null), 0);
});

// --- 5.4 subagent correlation ---------------------------------------------

test("a subagent's spans join the parent's tree", () => {
  const home = tmpHome("subagent");
  const parentTracer = new Tracer({ home, session: "parent", level: "info" });
  const pi = fakePi();
  const parent = attachTracing(pi, parentTracer, {} as NodeJS.ProcessEnv);
  pi.emit("tool_call", { toolCallId: "t1", toolName: "spawn_subagent", input: { task: "audit" } });

  // what the parent hands the child process
  const env = childTraceEnv(parentTracer);
  assert.equal(env[PARENT_SESSION_ENV], "parent");
  assert.ok(env[PARENT_SPAN_ENV], "the child hangs off the live span, not the session root");

  // the child, in its own process, with that env
  const childTracer = new Tracer({ home, session: "child", level: "info" });
  const childPi = fakePi();
  const child = attachTracing(childPi, childTracer, env as NodeJS.ProcessEnv);
  childPi.emit("tool_call", { toolCallId: "c1", toolName: "read_file", input: { path: "a" } });
  childPi.emit("tool_result", { toolCallId: "c1", result: "x" });
  child.finish();
  pi.emit("tool_result", { toolCallId: "t1", result: "ok" });
  parent.finish();

  const spans = readSpans(home);
  const childRoot = spans.find((s) => s.kind === "subagent")!;
  assert.equal(childRoot.session, "child");
  assert.equal(childRoot.attrs.parent_session, "parent");
  assert.equal(childRoot.parent_id, env[PARENT_SPAN_ENV]);

  // and the whole delegation tree renders as one nested thing
  const tree = formatTree(spans);
  const lines = tree.split("\n");
  const spawnLine = lines.findIndex((l) => l.includes("spawn_subagent"));
  const readLine = lines.findIndex((l) => l.includes("read_file"));
  assert.ok(spawnLine >= 0 && readLine > spawnLine, tree);
  assert.ok(indent(lines[readLine]!) > indent(lines[spawnLine]!),
    `the child's work must nest under the spawn:\n${tree}`);
  fs.rmSync(home, { recursive: true, force: true });
});

function indent(line: string): number {
  return line.length - line.trimStart().length;
}

// --- 5.5 rendering ---------------------------------------------------------

test("the tree renders roots in start order and shows failures", () => {
  const spans: Span[] = [
    { id: "a", parent_id: null, session: "s", kind: "session", name: "session", start: 2, end: 9, duration_ms: 7, ok: true, attrs: {} },
    { id: "b", parent_id: "a", session: "s", kind: "tool", name: "bash_exec", start: 3, end: 5, duration_ms: 2, ok: false, attrs: { output_bytes: 4 } },
    { id: "c", parent_id: null, session: "s", kind: "event", name: "first", start: 1, end: 1, duration_ms: 0, ok: true, attrs: {} },
  ];
  const tree = formatTree(spans, "s");
  const lines = tree.split("\n");
  assert.match(lines[0]!, /event:first/, "earlier root comes first");
  assert.match(lines[1]!, /session:session/);
  assert.match(lines[2]!, /✖ tool:bash_exec 2ms/, "failures are marked");
  assert.match(lines[2]!, /output_bytes=4/);
  assert.ok(indent(lines[2]!) > indent(lines[1]!));

  assert.equal(formatTree(spans, "other"), "(no spans)");
  assert.deepEqual(sessionsOf(spans), ["s"]);
});

test("a span whose parent was never written is still visible", () => {
  // a truncated or rotated-away parent must not hide its children
  const spans: Span[] = [
    { id: "x", parent_id: "gone", session: "s", kind: "tool", name: "orphan", start: 1, attrs: {} },
  ];
  assert.match(formatTree(spans, "s"), /orphan/);
});
