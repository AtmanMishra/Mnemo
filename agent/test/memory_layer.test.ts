/**
 * Memory-layer extension tests: drive the MemClient wrapper directly against a
 * temp journal. No LLM, no pi session - just the memsrv sidecar roundtrip.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemClient, recallFor, runConsolidate } from "../extensions/memory-layer.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sea-mem-test-"));
const journal = path.join(tmp, "journal.jsonl");

const client = new MemClient({ journalPath: journal });

after(() => {
  client.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("ping roundtrip", async () => {
  const res = await client.request("ping");
  assert.equal(res.ok, true);
  assert.equal(res.result.pong, true);
});

let episodeId = -1;

test("episode creates a task-episode node", async () => {
  const res = await client.request("episode", { label: "recovery task phase 1b" });
  assert.equal(res.ok, true);
  episodeId = Number(res.result.episode);
  assert.ok(Number.isFinite(episodeId) && episodeId >= 0);
});

test("fact attaches to the episode node", async () => {
  const res = await client.request("fact", {
    node: episodeId,
    key: "status",
    value: "all tests green",
  });
  assert.equal(res.ok, true);
  assert.ok(Number.isFinite(Number(res.result.fact)));
});

test("search finds the written fact", async () => {
  const res = await client.request("search", { query: "all tests green", k: 3 });
  assert.equal(res.ok, true);
  const results = res.result.results;
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0, "expected at least one search hit");
});

test("commit_log records on the episode", async () => {
  const res = await client.request("commit_log", {
    node: episodeId,
    kind: "tool_call",
    detail: "memory_layer.test: full roundtrip",
  });
  assert.equal(res.ok, true);
  assert.equal(res.result.logged, true);
});

test("state reflects the episode node", async () => {
  const res = await client.request("state", { node: episodeId });
  assert.equal(res.ok, true);
  assert.ok(res.result.state);
});

test("errors come back structured, server stays usable", async () => {
  const bad = await client.request("fact", { key: "k", value: "v" }); // no node
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /node/);
  const good = await client.request("ping");
  assert.equal(good.ok, true);
});

test("journal persists: a fresh client replays state", async () => {
  client.stop();
  const second = new MemClient({ journalPath: journal });
  try {
    const dump = await second.request("dump");
    assert.equal(dump.ok, true);
    const labels = dump.result.nodes.map((n: any) => n.label);
    assert.ok(labels.includes("recovery task phase 1b"));
  } finally {
    second.stop();
  }
});

test("consolidate distils repeated failures into a semantic lesson", async () => {
  // two episodes failing on the same theme -> one lesson
  for (const svc of ["checkout", "cart"]) {
    const ep = await client.request("episode", { label: `deploy ${svc}` });
    assert.equal(ep.ok, true);
    const steered = await client.request("steer", {
      episode: Number(ep.result.episode),
      failure: `helm rollback timed out on ${svc}`,
    });
    assert.equal(steered.ok, true, steered.error ?? "steer failed");
    assert.ok(steered.result.pain_node, "steer must leave a salience pain marker");
  }

  const lines: string[] = [];
  const count = await runConsolidate(client, (l) => lines.push(l));
  assert.ok(count >= 1, `expected a lesson, got: ${lines.join(" | ")}`);
  assert.ok(
    lines.some((l) => l.startsWith("lesson: ") && /helm|rollback/.test(l)),
    `lesson should name the shared theme: ${lines.join(" | ")}`,
  );

  // second pass writes nothing new
  const again: string[] = [];
  await runConsolidate(client, (l) => again.push(l));
  assert.match(again.at(-1)!, /0 op\(s\) written/);
});

test("consolidate reports the failure instead of throwing", async () => {
  const lines: string[] = [];
  const n = await runConsolidate(
    { request: async () => ({ ok: false, error: "memsrv is not running" }) },
    (l) => lines.push(l),
  );
  assert.equal(n, -1);
  assert.match(lines[0]!, /memsrv is not running/);
});

test("recall pulls the right node out of a real journal, and skips the rest", async () => {
  // the unit tests cover selection with a fake client; this is the whole path
  // through a real memsrv over a real journal, with real embeddings
  const node = await client.request("create_node", { kind: "aspect", label: "alerting" });
  await client.request("fact", {
    node: node.result.node, key: "deploy-window", value: "Friday 5pm",
  });
  const other = await client.request("create_node", { kind: "aspect", label: "unrelated-thing" });
  await client.request("fact", { node: other.result.node, key: "colour", value: "blue" });

  const block = await recallFor(client, "when is the deploy window this week");
  assert.match(block, /deploy-window: Friday 5pm/, "the answer is in front of the model");
  assert.doesNotMatch(block, /unrelated-thing/, "and the rest of the graph is not");

  assert.equal(await recallFor(client, "hi"), "", "a greeting recalls nothing");
});
