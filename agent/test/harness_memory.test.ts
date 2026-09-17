/**
 * P3 harness <-> memory indexing: create_harness records the bundle in memory
 * as a Harness node (Procedural area, manifest facts) so procedural recall can
 * find the capability later. First half uses the recall.test.ts fake-client
 * pattern (what is under test is the RPC shape and error handling); the last
 * test drives a real memsrv over a temp journal to prove the whole path.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { indexHarness, type HarnessIndexInput } from "../extensions/memory-layer.ts";

/** Records every request a fake client receives. */
function recordingClient(overrides: Record<string, (p: any) => any> = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    calls,
    async request(method: string, params: any = {}) {
      calls.push({ method, params });
      const handler = overrides[method] ?? ((p: any) => {
        if (method === "create_node") return { ok: true, result: { node: p.label === "bad" ? undefined : 5 } };
        if (method === "fact") return { ok: true, result: { fact: 99 } };
        return { ok: true, result: {} };
      });
      return handler(params);
    },
  };
  return client;
}

const bundle: HarnessIndexInput = {
  name: "k8s-debug",
  description: "debug a broken cluster",
  tools: ["kubectl_watch", "helm_status"],
  dir: "/tmp/.agents/skills/k8s-debug",
  bundleId: "k8s-debug@1",
};

test("indexes a harness as a Procedural Harness node with manifest facts", async () => {
  const client = recordingClient();
  const res = await indexHarness(client as any, bundle);
  assert.deepEqual(res, { ok: true, node: 5 });

  assert.deepEqual(client.calls[0], {
    method: "create_node",
    params: { kind: "harness", area: "procedural", label: "k8s-debug" },
  });
  const facts = client.calls.slice(1).map((c) => c.params);
  assert.deepEqual(facts, [
    { node: 5, key: "description", value: "debug a broken cluster" },
    // the tool list is a set, so those writes opt out of supersession
    { node: 5, key: "tool", value: "kubectl_watch", append: true },
    { node: 5, key: "tool", value: "helm_status", append: true },
    { node: 5, key: "location", value: "/tmp/.agents/skills/k8s-debug" },
    { node: 5, key: "bundle", value: "k8s-debug@1" },
  ]);
});

test("a failed create_node reports the error and writes no facts", async () => {
  const client = recordingClient({
    create_node: async () => ({ ok: false, error: "journal read-only" }),
  });
  const res = await indexHarness(client as any, bundle);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /read-only/);
  assert.equal(client.calls.length, 1, "no facts after a failed create");
});

test("a throwing sidecar is reported as a failure, never thrown", async () => {
  const dead = { request: async () => { throw new Error("memsrv crashed"); } };
  const res = await indexHarness(dead as any, bundle);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /memsrv crashed/);
});

test("empty facts are skipped, name-only bundles still index", async () => {
  const client = recordingClient();
  const res = await indexHarness(client as any, { name: "minimal" });
  assert.deepEqual(res, { ok: true, node: 5 });
  assert.equal(client.calls.length, 1, "no facts at all for a name-only bundle");
});

const tmp = mkdtempSync(path.join(os.tmpdir(), "sea-harness-mem-"));

test("a real memsrv: created bundle is recallable by its purpose, in the Procedural area", async () => {
  const { MemClient } = await import("../extensions/memory-layer.ts");
  const journal = path.join(tmp, "journal.jsonl");
  const client = new MemClient({ journalPath: journal, binaryPath: process.env.MNEMO_MEMSRV_BIN });
  try {
    const res = await indexHarness(client, {
      name: "unit-helper",
      description: "run project unit tests with a dry-run flag",
      tools: ["run_units"],
      dir: "/tmp/skills/unit-helper",
    });
    assert.equal(res.ok, true);

    const dump = await client.request("dump");
    const node = dump.result.nodes.find((n: any) => n.label === "unit-helper");
    assert.ok(node, "harness node exists");
    assert.equal(node.kind, "Harness");
    assert.equal(node.area, "Procedural");

    const hit = await client.request("search", { query: "run unit tests dry-run", k: 3 });
    const labels = hit.result.results.map((r: any) => r.label);
    assert.equal(labels[0], "unit-helper",
      `the purpose must recall the harness, got: ${labels.join(", ")}`);

    const state = await client.request("state", { node: res.ok ? res.node : 0 });
    assert.match(state.result.state, /run project unit tests/);
    assert.match(state.result.state, /run_units/);
  } finally {
    client.stop();
  }
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));