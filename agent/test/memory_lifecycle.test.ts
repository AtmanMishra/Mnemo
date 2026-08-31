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
         consolidateIfDue, CONSOLIDATE_THRESHOLD } from "../extensions/memory-layer.ts";

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
    await handlers.session_start(); // baseline: 1 episode (this session)

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
    await handlers.session_start(); // baseline: 1 episode

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