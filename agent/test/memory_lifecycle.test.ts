/**
 * P1 lifecycle: automatic failure->steer with per-episode dedupe, and
 * auto-consolidate at session shutdown once a session adds a threshold of new
 * episodes. Every test drives the REAL handlers through a fake pi with a real
 * memsrv over a temp journal — no LLM anywhere.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemClient, registerLifecycle, newLifecycleState, autoSteer,
         consolidateIfDue, CONSOLIDATE_THRESHOLD, makeMemoryTools } from "../extensions/memory-layer.ts";

interface FakePi {
  on(name: string, h: (...args: any[]) => any): void;
  handlers: Record<string, (...args: any[]) => any>;
}

function fakePi(): FakePi {
  const handlers: Record<string, (...args: any[]) => any> = {};
  return {
    on(name: string, h: (...args: any[]) => any) {
      handlers[name] = h;
    },
    handlers,
  };
}

function capturedLifecycle() {
  const calls: Array<{ method: string; params: any }> = [];
  const client = new MemClient();
  client.request = async (method, params = {}) => {
    calls.push({ method, params });
    return { ok: true, result: { episode: 7, episodes: 0 } };
  };
  const pi = fakePi();
  const state = newLifecycleState();
  registerLifecycle(pi, client, state);
  return { calls, client, state, handlers: pi.handlers };
}

test("an unwritten session creates no episode, even on shutdown", async () => {
  const { calls, handlers } = capturedLifecycle();
  await handlers.session_start();
  await handlers.before_agent_start({ systemPrompt: "system", prompt: "hello" });
  await handlers.session_shutdown();
  assert.deepEqual(calls.map((c) => c.method), ["stats", "stats"]);
});

test("first fact, log or steer creates one shared episode, never at session start", async () => {
  for (const first of ["fact", "log", "steer"]) {
    const { client, state, calls, handlers } = capturedLifecycle();
    await handlers.session_start();
    assert.equal(state.episodeId, null);
    const tools = makeMemoryTools(client, state);
    if (first === "fact") {
      await tools.find((t) => t.name === "memory_write_fact").execute("1", { node: 42, key: "port", value: "8080" });
    } else if (first === "steer") {
      await tools.find((t) => t.name === "memory_steer").execute("1", { failure: "build failed" });
    } else {
      await handlers.tool_execution_end({ toolName: "read_file", isError: false });
    }
    await handlers.turn_end({ message: { stopReason: "stop" } });
    await handlers.session_shutdown();
    assert.equal(calls.filter((c) => c.method === "episode").length, 1, first);
    assert.equal(state.episodeId, 7);
    assert.ok(calls.some((c) => c.method === "commit_log" && c.params.node === 7));
  }
});

test("concurrent first writes share episode creation and a failed creation can retry", async () => {
  const { client, state, calls, handlers } = capturedLifecycle();
  await handlers.session_start();
  const request = client.request;
  client.request = async () => ({ ok: false, error: "offline" });
  await handlers.tool_execution_end({ toolName: "read_file", isError: false });
  assert.equal(state.episodeId, null);
  client.request = request;
  await Promise.all([1, 2].map(() => handlers.tool_execution_end({ toolName: "read_file", isError: false })));
  assert.equal(calls.filter((c) => c.method === "episode").length, 1);
});

test("a reused lifecycle starts the next session empty with fresh turn numbering", async () => {
  const { calls, handlers, state } = capturedLifecycle();
  await handlers.session_start();
  await handlers.turn_end({ message: { stopReason: "stop" } });
  await handlers.session_shutdown();
  await handlers.session_start();
  assert.equal(state.episodeId, null);
  await handlers.turn_end({ message: { stopReason: "stop" } });
  assert.equal(calls.filter((c) => c.method === "episode").length, 2);
  assert.equal(calls.filter((c) => c.method === "fact" && c.params.key === "turn 1: quality").length, 2);
});

async function recalledLifecycle() {
  const setup = capturedLifecycle();
  const request = setup.client.request;
  setup.client.request = async (method, params = {}) => {
    if (method === "search") return { ok: true, result: { results: [
      { node: 11, kind: "Aspect", score: 0.9, label: "deploy settings",
        state: "[Aspect] deploy settings #11\nfacts:\n  - command: kubeseal encrypt" },
      { node: 22, kind: "Aspect", score: 0.8, label: "deploy settings",
        state: "[Aspect] deploy settings #22\nfacts:\n  - command: terraform workspace" },
    ] } };
    return request(method, params);
  };
  await setup.handlers.session_start();
  await setup.handlers.before_agent_start({ systemPrompt: "system", prompt: "what are the deploy settings" });
  return { ...setup, votes: () => setup.calls.filter((c) => c.method === "mark_useful") };
}

test("recall credits an echoed fact once and leaves an ignored node unvoted", async () => {
  const { handlers, votes } = await recalledLifecycle();
  assert.deepEqual(votes(), [], "retrieval is not use");
  await handlers.turn_end({ message: { stopReason: "stop", content: [
    { type: "text", text: "Use KUBESEAL to ENCRYPT the manifests." },
  ] } });
  assert.deepEqual(votes().map((c) => c.params), [{ node: 11 }]);
});

test("recall credits later tool arguments once, never the tool result or another turn", async () => {
  const { handlers, votes } = await recalledLifecycle();
  await handlers.tool_execution_start({ args: { command: "kubeseal encrypt" } });
  await handlers.tool_execution_start({ args: { command: "kubeseal encrypt" } });
  await handlers.tool_execution_end({ toolName: "bash_exec", isError: false, result: "terraform workspace" });
  await handlers.turn_end({ message: { stopReason: "toolUse", content: [] } });
  await handlers.tool_execution_start({ args: { command: "terraform workspace" } });
  await handlers.turn_end({ message: { stopReason: "stop", content: [{ type: "text", text: "terraform workspace" }] } });
  assert.deepEqual(votes().map((c) => c.params), [{ node: 11 }]);
});

test("shared recall words, hidden reasoning and substrings are not evidence of use", async () => {
  const { handlers, votes } = await recalledLifecycle();
  await handlers.turn_end({ message: { stopReason: "stop", content: [
    { type: "thinking", thinking: "kubeseal encrypt" },
    { type: "text", text: "deploy settings command kubesealed encryption" },
  ] } });
  assert.deepEqual(votes(), []);
});

test("usefulness feedback tolerates throwing, rejecting and stalled sidecars", async () => {
  for (const mode of ["throw", "reject", "stall"]) {
    const { client, handlers } = await recalledLifecycle();
    const request = client.request;
    client.request = (method, params) => {
      if (method !== "mark_useful") return request(method, params);
      if (mode === "throw") throw new Error("dead sidecar");
      if (mode === "reject") return Promise.reject(new Error("dead sidecar"));
      return new Promise(() => {});
    };
    await handlers.tool_execution_start({ args: { command: "kubeseal encrypt" } });
    await handlers.turn_end({ message: { stopReason: "stop", content: [] } });
  }
});

test("turn quality records ok, partial and failed with per-turn counts in facts and logs", async () => {
  const { calls, handlers } = capturedLifecycle();
  await handlers.session_start();
  for (const [index, errors, stopReason, quality] of [
    [0, [], "stop", "ok"],
    [1, [false, true], "stop", "partial"],
    [2, [true], "error", "failed"],
    [3, [], "error", "failed"],
    [4, [false], "toolUse", "ok"],
  ] as const) {
    // turn_end repeats tool results; they must not count twice.
    for (const isError of errors) {
      await handlers.tool_execution_end({ toolName: "read_file", isError });
    }
    await handlers.turn_end({ turnIndex: index, message: { stopReason },
      toolResults: errors.map((isError) => ({ isError })) });
    assert.ok(calls.some((c) => c.method === "fact" && c.params.node === 7
      && c.params.key === `turn ${index + 1}: quality` && c.params.value === quality));
    const notes = `tools=${errors.length}; errors=${errors.filter(Boolean).length}; stop=${stopReason}`;
    assert.ok(calls.some((c) => c.method === "fact"
      && c.params.key === `turn ${index + 1}: notes` && c.params.value === notes));
    assert.ok(calls.some((c) => c.method === "commit_log" && c.params.kind === "turn_quality"
      && c.params.detail === `turn ${index + 1}: ${quality}; ${notes}`));
  }
});

test("turn quality uses turn_end results even when execution hooks did not run", async () => {
  const { calls, handlers } = capturedLifecycle();
  await handlers.session_start();
  await handlers.turn_end({ message: { stopReason: "stop" }, toolResults: [{ isError: true }] });
  assert.ok(calls.some((c) => c.method === "fact" && c.params.value === "partial"));
  assert.ok(calls.some((c) => c.method === "fact" && c.params.value === "tools=1; errors=1; stop=stop"));
});

test("turn quality survives sidecar failure and clears counts before the next turn", async () => {
  const { client, calls, handlers } = capturedLifecycle();
  await handlers.session_start();
  const request = client.request;
  client.request = async () => { throw new Error("sidecar died"); };
  await handlers.tool_execution_end({ toolName: "read_file", isError: true });
  await handlers.turn_end({ message: { stopReason: "error" } });
  client.request = request;
  await handlers.turn_end({ message: { stopReason: "stop" } });
  assert.ok(calls.some((c) => c.method === "fact" && c.params.key === "turn 2: quality"
    && c.params.value === "ok"));
});

test("a quality write failure does not suppress existing turn failure steering", async () => {
  const { client, calls, handlers } = capturedLifecycle();
  await handlers.session_start();
  const request = client.request;
  client.request = (method, params) => method === "fact"
    ? Promise.reject(new Error("fact write failed")) : request(method, params);
  await handlers.turn_end({ message: { stopReason: "error", errorMessage: "provider failed" } });
  assert.ok(calls.some((c) => c.method === "steer" && c.params.failure === "provider failed"));
});

let counter = 0;
function freshClient(): { client: MemClient; dir: string; handlers: Record<string, (...args: any[]) => any> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sea-lifecycle-${counter++}-`));
  const client = new MemClient({ journalPath: path.join(dir, "journal.jsonl") });
  const pi = fakePi();
  const state = newLifecycleState();
  registerLifecycle(pi, client, state);
  return { client, dir, handlers: pi.handlers };
}

async function painMarkers(client: MemClient): Promise<number> {
  const dump = await client.request("dump");
  return dump.result.nodes.filter((n: any) => n.area === "Salience").length;
}

async function semanticLessons(client: MemClient): Promise<string[]> {
  const dump = await client.request("dump");
  return dump.result.nodes
    .filter((n: any) => n.area === "Semantic" && n.label.startsWith("lesson:"))
    .map((n: any) => n.label);
}

test("a failed tool steers once per episode, never per call; success never steers", async () => {
  const { client, dir, handlers } = freshClient();
  try {
    await handlers.session_start();

    const before = await painMarkers(client);
    // same tool, same failure, twice: one steer, not two
    await handlers.tool_execution_end({ toolName: "bash_exec", isError: true, result: "exit code 2" });
    await handlers.tool_execution_end({ toolName: "bash_exec", isError: true, result: "exit code 2" });
    // a different failure of the same tool is separate evidence
    await handlers.tool_execution_end({ toolName: "bash_exec", isError: true, result: "no such cmd" });
    // a successful tool is committed to the log but never steers
    await handlers.tool_execution_end({ toolName: "read_file", isError: false, result: "contents" });

    assert.equal(await painMarkers(client), before + 2,
      "two distinct failures -> two pain markers; repeats and successes none");
  } finally {
    client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the same failure steers again in a later episode", async () => {
  const { client, dir, handlers } = freshClient();
  try {
    await handlers.session_start();
    await handlers.tool_execution_end({ toolName: "bash_exec", isError: true, result: "exit code 2" });
    const afterFirst = await painMarkers(client);

    // a NEW session (new episode) re-encounters the exact same failure
    const pi2 = fakePi();
    const state2 = newLifecycleState();
    registerLifecycle(pi2, client, state2);
    await pi2.handlers.session_start();
    await pi2.handlers.tool_execution_end({ toolName: "bash_exec", isError: true, result: "exit code 2" });

    assert.equal(await painMarkers(client), afterFirst + 1,
      "per-episode dedupe: same failure in a new episode is new evidence");
  } finally {
    client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed turn (provider error) steers; a clean turn does not", async () => {
  const { client, dir, handlers } = freshClient();
  try {
    await handlers.session_start();
    const before = await painMarkers(client);

    await handlers.turn_end({ message: { stopReason: "error", errorMessage: "provider 429 rate limit" } });
    assert.equal(await painMarkers(client), before + 1, "failed turn leaves a pain marker");

    await handlers.turn_end({ message: { stopReason: "stop" } });
    await handlers.turn_end({ message: { stopReason: "length" } });
    assert.equal(await painMarkers(client), before + 1, "clean turns never steer");
  } finally {
    client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown consolidates once a session adds a threshold of new episodes", async () => {
  const { client, dir, handlers } = freshClient();
  try {
    await handlers.session_start(); // baseline: no writes by this session

    // two child sessions on the SAME journal, both failing on a shared theme
    for (const svc of ["checkout", "cart"]) {
      const ep = await client.request("episode", { label: `deploy ${svc}` });
      await client.request("steer", {
        episode: Number(ep.result.episode),
        failure: `helm rollback timed out on ${svc}`,
      });
    }

    await handlers.session_shutdown();

    // gained = 2, threshold 3: the shutdown must NOT have consolidated
    assert.deepEqual(await semanticLessons(client), [],
      `2 new episodes are below the threshold of ${CONSOLIDATE_THRESHOLD}; a lesson would prove consolidation ran`);
  } finally {
    client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown DOES consolidate once the session crosses the episode threshold", async () => {
  const { client, dir, handlers } = freshClient();
  try {
    await handlers.session_start(); // baseline: no writes by this session

    for (const svc of ["checkout", "cart", "wishlist"]) {
      const ep = await client.request("episode", { label: `deploy ${svc}` });
      await client.request("steer", {
        episode: Number(ep.result.episode),
        failure: `helm rollback timed out on ${svc}`,
      });
    }

    await handlers.session_shutdown();

    const lessons = await semanticLessons(client);
    assert.ok(
      lessons.some((l) => /helm/.test(l) && /rollback/.test(l)),
      `3 new episodes cross the threshold; expected a helm/rollback lesson, got: ${lessons.join(" | ")}`,
    );
  } finally {
    client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no baseline means shutdown never guesses and never breaks", async () => {
  // stats is unreachable from the start (countEpisodes -> null): nothing to
  // compare, so consolidation is skipped rather than run on a guess, and the
  // failure is reported as "false", not thrown.
  const bad = { request: async () => ({ ok: false, error: "memsrv is not running" }) };
  const state = newLifecycleState(); // startEpisodes stays null: never set
  const lines: string[] = [];
  const did = await consolidateIfDue(bad, state, (l) => lines.push(l));
  assert.equal(did, false, "a null baseline must not run consolidation");
  assert.equal(lines.length, 0, "and must not even log a guess");
});

test("auto-steer tolerates a dead sidecar, dedupes, and never throws", async () => {
  const dead = { request: async () => { throw new Error("memsrv crashed"); } };
  const state = newLifecycleState();
  state.episodeId = 7;
  await autoSteer(dead, state, "tool", "bash_exec failed"); // must not throw
  await autoSteer(dead, state, "tool", "bash_exec failed"); // deduped, client not called
  assert.equal(state.steered.get(7)!.size, 1);
  // a different signature in the same episode is still new evidence
  state.episodeId = 7;
  await autoSteer(dead, state, "turn", "provider 429");
  assert.equal(state.steered.get(7)!.size, 2);
});
