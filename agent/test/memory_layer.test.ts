/**
 * Memory-layer extension tests: drive the MemClient wrapper directly against a
 * temp journal. No LLM, no pi session - just the memsrv sidecar roundtrip.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemClient } from "../extensions/memory-layer.ts";

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
