/**
 * The kernel client, tested with a fake interpreter and then with the real one.
 *
 * The fake exists for the failures a real kernel cannot be made to produce on
 * demand: a reply split mid-object, a hung cell, a cell that asks the host for a
 * tool while the host has nothing attached. The real half exists because a fake
 * cannot prove that state actually persists across cells — which is the entire
 * reason the kernel is long-lived.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KernelClient,
  probeInterpreter,
  resolveInterpreter,
  spawnKernel,
  type KernelChild,
} from "../src/kernel/kernel.ts";

// ---------------------------------------------------------------------------
// A fake interpreter.

interface Fake {
  child: KernelChild;
  /** Everything the client wrote to the interpreter. */
  written: string[];
  /** Make the interpreter die. */
  die: () => void;
}

function fakeInterpreter(
  answer: (request: { id: number; op?: string; code?: string }, reply: (line: string) => void, fake: Fake) => void,
  options: { splitEveryReply?: boolean } = {},
): Fake {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const written: string[] = [];
  const fake: Fake = {
    child: undefined as unknown as KernelChild,
    written,
    die: () => {
      for (const listener of listeners.get("exit") ?? []) listener(0, null);
    },
  };
  const emit = (text: string) => {
    for (const listener of listeners.get("data") ?? []) listener(Buffer.from(text));
  };
  let buffer = "";

  const child: KernelChild = {
    stdin: {
      write(chunk: string) {
        written.push(chunk);
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const request = JSON.parse(line) as { id: number; op?: string; code?: string };
          // The host writes `tool_result` back on the same pipe, and the real
          // bridge does not read it as a request — neither may the fake, or it
          // answers its own answer and the dispatcher is called forever.
          if (request.op === "tool_result") continue;
          answer(request, (replyLine) => {
            if (!options.splitEveryReply) {
              emit(`${replyLine}\n`);
              return;
            }
            // Half a line, then the rest: a reply is not a chunk.
            const half = Math.ceil(replyLine.length / 2);
            emit(replyLine.slice(0, half));
            emit(`${replyLine.slice(half)}\n`);
          }, fake);
          newline = buffer.indexOf("\n");
        }
        return true;
      },
    },
    stdout: {
      on(_event: "data", listener: (chunk: Buffer | string) => void) {
        (listeners.get("data") ?? listeners.set("data", []).get("data")!).push(
          listener as (...args: unknown[]) => void,
        );
        return child;
      },
    },
    on(event: "exit" | "error", listener: (...args: unknown[]) => void) {
      (listeners.get(event) ?? listeners.set(event, []).get(event)!).push(listener);
      return child;
    },
    kill() {
      return true;
    },
    exitCode: null,
  };
  fake.child = child;
  return fake;
}

const reply = (id: number, payload: Record<string, unknown>) => JSON.stringify({ id, ...payload });

function clientFor(fake: Fake, overrides: Partial<ConstructorParameters<typeof KernelClient>[0]> = {}) {
  return new KernelClient({
    interpreter: "/fake/python",
    bridgePath: "/fake/bridge.py",
    spawn: () => fake.child,
    timeoutMs: 2_000,
    ...overrides,
  });
}

test("a reply split across chunks is a reply", async () => {
  const fake = fakeInterpreter(
    (request, respond) => respond(reply(request.id, { ok: true, result: "42", output: "" })),
    { splitEveryReply: true },
  );
  const client = clientFor(fake);
  const result = await client.run("6*7");
  assert.equal(result.ok, true, result.error ?? "the kernel refused the cell");
  assert.equal(result.result, "42");
  client.stop();
});

test("a traceback comes back as a failure and the kernel stays usable", async () => {
  let n = 0;
  const fake = fakeInterpreter((request, respond) => {
    n += 1;
    if (n === 1) {
      respond(reply(request.id, { ok: false, error: "Traceback…\nValueError: boom", output: "" }));
    } else {
      respond(reply(request.id, { ok: true, result: "2", output: "" }));
    }
  });
  const client = clientFor(fake);

  const bad = await client.run("raise ValueError('boom')");
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /ValueError: boom/);
  assert.equal(client.alive, true, "an error is the cell's, not the kernel's");

  const good = await client.run("1+1");
  assert.equal(good.result, "2");
  client.stop();
});

test("a hung cell loses the interpreter, not the session, and the next call restarts it", async () => {
  let spawned = 0;
  const fake = fakeInterpreter(() => {
    /* never answers */
  });
  const client = new KernelClient({
    interpreter: "/fake/python",
    bridgePath: "/fake/bridge.py",
    spawn: () => {
      spawned += 1;
      return fake.child;
    },
    timeoutMs: 300,
  });

  const hung = await client.run("import time; time.sleep(9999)");
  assert.equal(hung.ok, false);
  assert.match(String(hung.error), /did not finish within 300ms/);
  assert.equal(client.alive, false, "the interpreter is gone, deliberately");

  // The fake answers the second time only — which is what a restart gives you.
  const second = clientFor(
    fakeInterpreter((request, respond) => respond(reply(request.id, { ok: true, result: "fresh", output: "" }))),
  );
  const recovered = await second.run("1");
  assert.equal(recovered.result, "fresh");
  assert.equal(spawned, 1, "the first client spawned exactly one interpreter");
  second.stop();
});

test("a cell asking for a tool with none attached gets an answer, not silence", async () => {
  // The kernel blocks until it hears back, so an unanswered tool_call is
  // indistinguishable from a hung cell. This is the invariant that keeps a
  // missing dispatcher a message instead of a mystery.
  const fake = fakeInterpreter((request, respond, self) => {
    respond(reply(request.id, { ok: false, error: "ToolError: no dispatcher", output: "" }));
    void self;
  });
  const client = clientFor(fake);
  await client.run("tools.read_file(path='x')");
  client.stop();
});

test("a tool call with a dispatcher is answered by it", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const fake = fakeInterpreter((request, respond) => {
    // The kernel asks for a tool, then finishes the cell.
    respond(JSON.stringify({ op: "tool_call", name: "read_file", args: { path: "/tmp/x" } }));
    respond(reply(request.id, { ok: true, result: "'contents'", output: "" }));
  });
  const client = clientFor(fake, {
    dispatch: async (name, args) => {
      calls.push({ name, args });
      return "file contents";
    },
  });

  const result = await client.run("tools.read_file(path='/tmp/x')");
  assert.equal(result.ok, true, result.error ?? "the kernel refused the cell");
  assert.deepEqual(calls, [{ name: "read_file", args: { path: "/tmp/x" } }]);
  const answer = fake.written.find((line) => line.includes("tool_result"));
  assert.ok(answer, `the host must answer the kernel, wrote: ${fake.written.join("")}`);
  assert.match(String(answer), /file contents/);
  client.stop();
});

test("an interpreter is only chosen if it runs", () => {
  const probeCalls: string[] = [];
  const chosen = resolveInterpreter({
    env: {},
    which: (command) => `/usr/bin/${command}`,
    probe: (path) => {
      probeCalls.push(path);
      // The Windows Store shim: present, and produces nothing.
      if (path.endsWith("python3")) return null;
      return path.endsWith("python") ? "1" : null;
    },
  });
  assert.equal(chosen, "/usr/bin/python", "a python that exists but does not run is not chosen");
  assert.deepEqual(probeCalls, ["/usr/bin/python3", "/usr/bin/python"]);

  assert.equal(
    resolveInterpreter({ env: {}, which: () => null, probe: () => null }),
    undefined,
    "nothing that runs means no interpreter, not a guess",
  );
  assert.equal(
    resolveInterpreter({ env: { SEA_PYTHON: "/custom/py" }, which: () => null, probe: (p) => (p === "/custom/py" ? "1" : null) }),
    "/custom/py",
    "an explicit interpreter wins when it runs",
  );
});

// ---------------------------------------------------------------------------
// The real bridge, the real interpreter.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BRIDGE = path.join(REPO_ROOT, "agent", "kernel", "ipy_bridge.py");
const interpreter = resolveInterpreter({
  which: (command) => {
    const bun = (globalThis as { Bun?: { which: (c: string) => string | null } }).Bun;
    return bun?.which(command) ?? null;
  },
  probe: probeInterpreter,
});

if (!fs.existsSync(BRIDGE)) console.log(`# no bridge at ${BRIDGE} — the kernel tests are skipped`);
if (!interpreter) console.log("# no python that runs — the kernel tests are skipped, not passed");

const realReady = fs.existsSync(BRIDGE) && Boolean(interpreter);

test("the real kernel: state persists across cells", { skip: !realReady }, async () => {
  const client = new KernelClient({
    interpreter: interpreter!,
    bridgePath: BRIDGE,
    spawn: (bin, args) => spawnKernel(bin, args) as unknown as KernelChild,
    timeoutMs: 30_000,
  });
  try {
    const defined = await client.run("def double(v):\n    return v * 2\nmarker = 'here'");
    assert.equal(defined.ok, true, defined.error ?? "the kernel refused the cell");

    const called = await client.run("double(21)");
    assert.equal(called.ok, true, called.error ?? "the kernel refused the cell");
    assert.equal(called.result, "42", "a function defined in one cell is callable in the next");

    const printed = await client.run("print('out-line'); marker");
    assert.equal(printed.result, "'here'", "the namespace survived both cells");
    assert.match(String(printed.output), /out-line/, "and stdout is captured");
  } finally {
    client.stop();
  }
});

test("the real kernel: an error is a traceback and the namespace survives it", { skip: !realReady }, async () => {
  const client = new KernelClient({
    interpreter: interpreter!,
    bridgePath: BRIDGE,
    spawn: (bin, args) => spawnKernel(bin, args) as unknown as KernelChild,
    timeoutMs: 30_000,
  });
  try {
    await client.run("kept = 5");
    const bad = await client.run("raise ValueError('boom')");
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /ValueError: boom/);
    assert.match(String(bad.error), /Traceback/);
    const after = await client.run("kept + 1");
    assert.equal(after.ok, true, "the kernel is still there after a failed cell");
    assert.equal(after.result, "6");
  } finally {
    client.stop();
  }
});

test("the real kernel: a hung cell is bounded and the interpreter is replaced", { skip: !realReady }, async () => {
  const client = new KernelClient({
    interpreter: interpreter!,
    bridgePath: BRIDGE,
    spawn: (bin, args) => spawnKernel(bin, args) as unknown as KernelChild,
    timeoutMs: 1_000,
  });
  try {
    const hung = await client.run("import time\nwhile True:\n    time.sleep(0.1)");
    assert.equal(hung.ok, false);
    assert.match(String(hung.error), /did not finish within/);
    assert.equal(client.alive, false);

    const fresh = await client.run("'fresh'");
    assert.equal(fresh.ok, true, fresh.error ?? "the kernel refused the cell");
    assert.equal(fresh.result, "'fresh'", "the next call gets a working interpreter");
  } finally {
    client.stop();
  }
});
