import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
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
