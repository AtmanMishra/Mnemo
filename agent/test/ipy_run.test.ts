import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn as spawnImpl } from "node:child_process";
import { IPyKernel, ipyRunTool, sharedKernel } from "../src/tools/index.ts";

beforeEach(async () => {
  if (sharedKernel.alive) await sharedKernel.restart();
});

// Kill the shared interpreter so the test runner's event loop can drain and
// the suite exits instead of hanging on open stdio pipes.
after(() => {
  sharedKernel.stop();
});

test("kernel persists variables across calls (the core requirement)", async () => {
  const first = await ipyRunTool.execute("i1", { code: "x = 41" });
  assert.equal((first.details as any).ok, true);
  const second = await ipyRunTool.execute("i2", { code: "x + 1" });
  assert.equal((second.details as any).ok, true);
  assert.equal((second.details as any).result, "42");
});

test("kernel keeps imports and functions alive", async () => {
  await sharedKernel.run("import math\ndef double(v):\n    return v * 2");
  const res = await sharedKernel.run("double(math.pi)");
  assert.equal(res.ok, true);
  assert.equal(Number(res.result), Number(Math.PI) * 2);
});

test("errors come back as tracebacks, kernel stays usable", async () => {
  const bad = await sharedKernel.run("raise ValueError('boom')");
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /ValueError: boom/);
  assert.match(bad.error!, /Traceback/);
  const good = await sharedKernel.run("1 + 1");
  assert.equal(good.result, "2");
});

test("stdout/stderr are captured", async () => {
  const res = await sharedKernel.run("print('out-line'); import sys; sys.stderr.write('err-line')");
  assert.match(res.output ?? "", /out-line/);
  assert.match(res.output ?? "", /err-line/);
});

test("last expression value is returned via repr", async () => {
  const res = await sharedKernel.run("[1, 2, 3]");
  assert.equal(res.result, "[1, 2, 3]");
});

test("restart clears state", async () => {
  await sharedKernel.run("marker = 'here'");
  const before = await sharedKernel.run("'marker' in dir()");
  assert.equal(before.result, "True");
  await sharedKernel.restart();
  const after = await sharedKernel.run("'marker' in dir()");
  assert.equal(after.result, "False");
});

test("multiple pending calls execute sequentially in order", async () => {
  await sharedKernel.run("log = []");
  const calls = Promise.all([
    sharedKernel.run("log.append(1); __import__('time').sleep(0.05); list(log)"),
    sharedKernel.run("log.append(2); log"),
    sharedKernel.run("log.append(3); log"),
  ]);
  const [r1, r2, r3] = await calls;
  assert.deepEqual(JSON.parse(r1.result!), [1]);
  assert.deepEqual(JSON.parse(r2.result!), [1, 2]);
  assert.deepEqual(JSON.parse(r3.result!), [1, 2, 3]);
});

test("hung cell hits timeout and kernel recovers on next call", async () => {
  const hung = await sharedKernel.run("__import__('time').sleep(10)", 500);
  assert.equal(hung.ok, false);
  assert.match(hung.error!, /timed out/);
  assert.ok(!sharedKernel.alive, "kernel should be dead after timeout kill");
  const fresh = await sharedKernel.run("6 * 7");
  assert.equal(fresh.result, "42");
});

test("fresh standalone kernel instance works independently", async () => {
  const k = new IPyKernel();
  try {
    await k.run("z = 5");
    const res = await k.run("z * z");
    assert.equal(res.result, "25");
  } finally {
    k.stop();
  }
});

// --- 21 (D6): the interpreter's environment -------------------------------

/**
 * A stand-in interpreter: a Node process would do, but the kernel spawns
 * `pythonBin -u bridge`, and `-u` is not a node flag. So this fakes the
 * child_process object instead: it answers the handshake and the run request
 * over the same JSON-lines protocol the real bridge speaks, and lets the test
 * read the exact env the kernel handed it. No python3, no shell, no
 * platform-specific helper — deterministic on Windows too.
 */
function fakeKernelChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0, null); };
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line);
      const reply = req.op === "ping"
        ? { id: 0, ok: true, result: "pong", output: "" }
        : { id: req.id, ok: true, result: "fake-kernel", output: "" };
      child.stdout.write(JSON.stringify(reply) + "\n");
    }
  });
  return child;
}

function fakeSpawn(captured: { env?: NodeJS.ProcessEnv }) {
  return ((_cmd: string, _args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
    captured.env = opts.env;
    return fakeKernelChild();
  }) as unknown as typeof spawnImpl;
}

test("the kernel process is spawned with the session's PI_* env (D6)", async () => {
  const captured: { env?: NodeJS.ProcessEnv } = {};
  const k = new IPyKernel("python3", "unused-bridge.py", fakeSpawn(captured));
  const saved = {
    id: process.env.PI_SESSION_ID,
    cred: process.env.SEA_TEST_FAKE_API_KEY,
  };
  process.env.PI_SESSION_ID = "stale-parent-session";
  process.env.SEA_TEST_FAKE_API_KEY = "«redacted:sk-…»";
  try {
    k.setSessionEnv({
      sessionId: "kernel-sess",
      provider: "acme",
      model: "m1",
      reasoningLevel: "medium",
      // sessionFile deliberately unknown: the stale inherited one must not survive
    });
    const res = await k.run("1 + 1");
    assert.equal(res.ok, true, res.error ?? "fake kernel run failed");
    assert.equal(res.result, "fake-kernel");
    const env = captured.env ?? {};
    assert.equal(env.PI_SESSION_ID, "kernel-sess", "the live session id, not the stale one");
    assert.equal(env.PI_PROVIDER, "acme");
    assert.equal(env.PI_MODEL, "m1");
    assert.equal(env.PI_REASONING_LEVEL, "medium");
    assert.ok(!("PI_SESSION_FILE" in env), "an ephemeral session publishes no file");
    assert.equal(env.SEA_TEST_FAKE_API_KEY, undefined, "12.7 still holds: credentials are scrubbed");
  } finally {
    k.stop();
    for (const [name, v] of Object.entries({ PI_SESSION_ID: saved.id, SEA_TEST_FAKE_API_KEY: saved.cred })) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  }
});

test("a kernel with no known session strips inherited PI_* (D6)", async () => {
  const captured: { env?: NodeJS.ProcessEnv } = {};
  const k = new IPyKernel("python3", "unused-bridge.py", fakeSpawn(captured));
  const saved = process.env.PI_MODEL;
  process.env.PI_MODEL = "stale-parent-model";
  try {
    k.setSessionEnv(undefined);
    assert.deepEqual(k.toolContext(), undefined);
    const res = await k.run("1 + 1");
    assert.equal(res.ok, true, res.error ?? "fake kernel run failed");
    assert.ok(!("PI_MODEL" in (captured.env ?? {})), "a parent's PI_MODEL must not leak");
    k.setSessionEnv({ sessionId: "s1" });
    assert.deepEqual(k.toolContext(), { sessionEnv: { sessionId: "s1" } });
  } finally {
    k.stop();
    if (saved === undefined) delete process.env.PI_MODEL;
    else process.env.PI_MODEL = saved;
  }
});
