/**
 * The memory client, tested twice over.
 *
 * The unit half drives a fake child process, which is the only way to test the
 * transport's failures deterministically: a reply split across chunks, an error
 * response, a sidecar that dies mid-request, one that never answers.
 *
 * The integration half runs the real `memsrv` against a temporary journal — the
 * actual Rust binary, the actual protocol — and skips with a printed reason when
 * the binary has not been built, because a test that silently passes when the
 * thing under test is absent is worse than no test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryClient, type MemoryChild } from "../src/memory/client.ts";

/** A reply the fake sidecar can send: an object (framed for you) or raw text. */
type FakeReply = { ok: boolean; result?: unknown; error?: string } | string;

/** What a test can make the fake do besides answering. */
export interface FakeControl {
  /** Fire the exit listeners, as a dying process would. */
  exit: () => void;
}

/** A child process that answers from a script, and can be told to misbehave. */
function fakeChild(
  behaviour: (reply: (response: FakeReply) => void) => void,
  control: FakeControl = { exit: () => {} },
): MemoryChild {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  control.exit = () => {
    for (const listener of listeners.get("exit") ?? []) listener(1, null);
  };
  let buffer = "";
  const emit = (line: string) => {
    for (const listener of listeners.get("data") ?? []) listener(Buffer.from(line));
  };
  const child: MemoryChild = {
    stdin: {
      write(chunk: string) {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const request = JSON.parse(line) as { id?: number; method: string };
          if (request.method === "exit") return true;
          behaviour(
            (reply) => {
              const payload =
                typeof reply === "string"
                  ? reply
                  : JSON.stringify({ id: request.id, ...(reply as Record<string, unknown>) });
              // Deliver in two chunks on purpose: a reply is not a chunk.
              const half = Math.ceil(payload.length / 2);
              emit(`${payload.slice(0, half)}`);
              emit(`${payload.slice(half)}\n`);
            },
          );
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
  return child;
}

function clientWith(child: MemoryChild): MemoryClient {
  return new MemoryClient({
    binaryPath: "/fake/memsrv",
    journalPath: "/fake/journal.jsonl",
    spawn: () => child,
    timeoutMs: 2_000,
  });
}

test("a reply split across chunks is a reply, not a parse error", async () => {
  const client = clientWith(
    fakeChild((reply) =>
      reply({ ok: true, result: { pong: true, echo: "x".repeat(200) } }),
    ),
  );
  const response = await client.request("ping");
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { pong: true, echo: "x".repeat(200) });
  client.stop();
});

test("an error from the sidecar arrives as a response, not a throw", async () => {
  const client = clientWith(fakeChild((reply) => reply({ ok: false, error: "node 7 does not exist" })));
  const response = await client.request("state", { node: 7 });
  assert.equal(response.ok, false);
  assert.match(String(response.error), /node 7/);
  client.stop();
});

test("two requests are serialized, and each gets its own answer", async () => {
  const seen: string[] = [];
  const client = clientWith(
    fakeChild((reply) => {
      // The fake answers in order; if the client wrote both at once, the ids
      // would interleave and this list would show the second arriving first.
      seen.push("request");
      reply({ ok: true, result: { n: seen.length } });
    }),
  );
  const [first, second] = await Promise.all([client.request("ping"), client.request("ping")]);
  assert.deepEqual(first.result, { n: 1 });
  assert.deepEqual(second.result, { n: 2 });
  assert.deepEqual(seen, ["request", "request"]);
  client.stop();
});

test("a sidecar that never answers is a timeout, not a hang", async () => {
  const client = clientWith(fakeChild(() => {}));
  const response = await client.request("ping");
  assert.equal(response.ok, false);
  assert.match(String(response.error), /did not answer/);
  client.stop();
});

test("a sidecar that dies mid-request resolves the callers instead of stranding them", async () => {
  const control: FakeControl = { exit: () => {} };
  const child = fakeChild(() => {}, control);
  const client = clientWith(child);
  const pending = client.request("search", { query: "anything" });
  // The client registers its own listeners when it starts the sidecar, which
  // happens inside the request's queue — so firing "exit" immediately would
  // fire at nobody. Wait until it is actually alive.
  for (let i = 0; i < 100 && !client.alive; i += 1) await new Promise((r) => setTimeout(r, 1));
  assert.equal(client.alive, true, "the client should have started the sidecar");
  control.exit();
  const response = await pending;
  assert.equal(response.ok, false);
  assert.match(String(response.error), /exited/);
  client.stop();
});

// ---------------------------------------------------------------------------
// Against the real binary.

// URL resolution is relative to this file's DIRECTORY (app/test/), so two hops
// reach the repository root — three landed on C:\, and the integration tests
// skipped themselves against a path that could not exist.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MEMSRV = process.env.MNEMO_MEMSRV_BIN ?? path.join(
  REPO_ROOT,
  "memory-layer",
  "target",
  "debug",
  process.platform === "win32" ? "memsrv.exe" : "memsrv",
);
const haveMemsrv = fs.existsSync(MEMSRV);
if (!haveMemsrv) {
  console.log(`# no memsrv at ${MEMSRV} — the integration tests are skipped, not passed`);
  console.log("#   build it with: cd memory-layer && cargo build --bin memsrv");
}

/**
 * Spawn the real binary and keep a handle on it.
 *
 * The client's own `stop()` only *asks* the sidecar to exit and then relies on
 * an unref'd timer to insist — correct for an application that must not be held
 * open by a timer, useless for a test runner that waits for every child to go
 * away. A test that leaves a `memsrv` alive hangs the suite, which is exactly
 * what happened the first time this ran.
 */
function realSpawn(children: MemoryChild[]) {
  return (binary: string, args: string[]): MemoryChild => {
    const child = spawn(binary, args) as unknown as MemoryChild;
    children.push(child);
    return child;
  };
}

function reap(children: MemoryChild[]): void {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  children.length = 0;
}

test("the real sidecar: a fact written is a fact recalled", { skip: !haveMemsrv }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-memory-"));
  const journal = path.join(dir, "journal.jsonl");
  const children: MemoryChild[] = [];
  const client = new MemoryClient({
    binaryPath: MEMSRV,
    journalPath: journal,
    spawn: realSpawn(children),
  });

  try {
    const ping = await client.request("ping");
    assert.equal(ping.ok, true, ping.error ?? "the sidecar refused the call");
    assert.deepEqual(ping.result, { pong: true });

    const episode = await client.request("episode", { label: "the rebuild" });
    assert.equal(episode.ok, true, episode.error ?? "the sidecar refused the call");
    const node = Number((episode.result as { episode: number }).episode);
    assert.ok(Number.isFinite(node));

    const fact = await client.request("fact", {
      node,
      key: "status",
      value: "the spine runs on Bun",
    });
    assert.equal(fact.ok, true, fact.error ?? "the sidecar refused the call");

    const search = await client.request("search", { query: "spine runs on Bun", k: 3 });
    assert.equal(search.ok, true, search.error ?? "the sidecar refused the call");
    const hits = (search.result as { results?: unknown[] }).results ?? [];
    assert.ok(hits.length > 0, "a fact just written must be found");

    const state = await client.request("state", { node });
    assert.equal(state.ok, true, state.error ?? "the sidecar refused the call");

    const dump = await client.request("dump");
    assert.equal(dump.ok, true, dump.error ?? "the sidecar refused the call");
    const labels = ((dump.result as { nodes?: { label: string }[] }).nodes ?? []).map((n) => n.label);
    assert.ok(labels.includes("the rebuild"), `the journal must hold the episode, got ${labels.join(", ")}`);

    // The journal is the record: it outlives the process that wrote it.
    assert.ok(fs.existsSync(journal));
    assert.ok(fs.statSync(journal).size > 0, "the journal is not empty");
    client.stop();

    const second = new MemoryClient({
      binaryPath: MEMSRV,
      journalPath: journal,
      spawn: realSpawn(children),
    });
    try {
      const replayed = await second.request("dump");
      assert.equal(replayed.ok, true, replayed.error ?? "the sidecar refused the call");
      const replayedLabels = ((replayed.result as { nodes?: { label: string }[] }).nodes ?? []).map(
        (n) => n.label,
      );
      assert.ok(replayedLabels.includes("the rebuild"), "a fresh process replays the journal");
    } finally {
      second.stop();
    }
  } finally {
    client.stop();
    reap(children);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the real sidecar: a missing journal directory is an error, not a crash", { skip: !haveMemsrv }, async () => {
  const children: MemoryChild[] = [];
  const client = new MemoryClient({
    binaryPath: MEMSRV,
    journalPath: path.join(os.tmpdir(), "definitely-not-here", "nested", "journal.jsonl"),
    spawn: realSpawn(children),
  });
  try {
    const response = await client.request("ping");
    // Either it creates what it needs or it says why not — both are fine, a hang
    // or an unhandled throw is not.
    assert.ok(response.ok === true || typeof response.error === "string");
  } finally {
    client.stop();
    reap(children);
  }
});
