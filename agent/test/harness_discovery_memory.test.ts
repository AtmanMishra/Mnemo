/**
 * Discovery-time harness indexing: idempotent. The same bundle discovered
 * twice (two list_skills runs, or create_harness followed by discovery) must
 * produce ONE Harness node, and the harness must be recallable by its purpose
 * afterwards.
 *
 * First group pins the lookup RPC shape with fake clients (recall.test.ts
 * pattern). The in-memory memsrv-like fake proves the two-discovery-pass
 * contract. The next test drives a REAL memsrv over a temp journal at the
 * function level. The list_skills WIRING is covered in
 * harness_discovery_wiring.test.ts — it needs its own process so the shared
 * client binds to a temp journal before any import.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  factsFromState,
  findHarnessNode,
  ensureHarnessIndexed,
  indexDiscoveredHarnesses,
  type HarnessIndexInput,
} from "../extensions/memory-layer.ts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "sea-disc-mem-"));

const bundle: HarnessIndexInput = {
  name: "k8s-debug",
  description: "debug a broken cluster",
  tools: ["kubectl_watch", "helm_status"],
  dir: "/tmp/.agents/skills/k8s-debug",
  bundleId: "k8s-debug@1",
};

/** Records every request; overrides per method. Defaults shape real memsrv. */
function recordingClient(overrides: Record<string, (p: any) => any> = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    calls,
    async request(method: string, params: any = {}) {
      calls.push({ method, params });
      const handler = overrides[method] ?? ((p: any) => {
        if (method === "dump") return { ok: true, result: { nodes: [] } };
        if (method === "state") return { ok: true, result: { state: "" } };
        if (method === "create_node") return { ok: true, result: { node: 7 } };
        if (method === "fact") return { ok: true, result: { fact: 99 } };
        return { ok: true, result: {} };
      });
      return handler(params);
    },
  };
  return client;
}

function harnessState(label: string, id: number, location?: string): string {
  const lines = [`[Harness/Procedural] ${label} #${id}`, "facts:"];
  if (location !== undefined) lines.push(`  - location: ${location}`);
  return lines.join("\n");
}

test("factsFromState parses the fact lines state_of renders", () => {
  const f = factsFromState(harnessState("k8s-debug", 4, "/tmp/x/k8s-debug") + "\n  - tool: kubectl_watch\nrecent log:\n  [1] commit_log: x");
  assert.equal(f.get("location"), "/tmp/x/k8s-debug");
  assert.equal(f.get("tool"), "kubectl_watch");
  assert.equal(f.size, 2, "log lines are not facts");
});

test("an already-indexed bundle is reused, nothing is written", async () => {
  const client = recordingClient({
    dump: async () => ({
      ok: true,
      result: { nodes: [{ id: 4, kind: "Harness", area: "Procedural", label: "k8s-debug" }] },
    }),
    state: async () => ({ ok: true, result: { state: harnessState("k8s-debug", 4, bundle.dir) } }),
  });
  const res = await ensureHarnessIndexed(client as any, bundle);
  assert.deepEqual(res, { ok: true, node: 4, existed: true });
  assert.deepEqual(client.calls.map((c) => c.method), ["dump", "state"], "a hit writes nothing");
});

test("the same label at a DIFFERENT bundle path is a different bundle", async () => {
  const client = recordingClient({
    dump: async () => ({
      ok: true,
      result: { nodes: [{ id: 4, kind: "Harness", area: "Procedural", label: "k8s-debug" }] },
    }),
    state: async () => ({ ok: true, result: { state: harnessState("k8s-debug", 4, "/elsewhere/k8s-debug") } }),
  });
  const res = await ensureHarnessIndexed(client as any, bundle);
  assert.deepEqual(res, { ok: true, node: 7, existed: false });
  const create = client.calls.filter((c) => c.method === "create_node");
  assert.equal(create.length, 1);
  assert.deepEqual(create[0].params, {
    kind: "harness", area: "procedural", label: "k8s-debug",
  });
});

test("a name-only bundle matches an existing node by label alone", async () => {
  const client = recordingClient({
    dump: async () => ({
      ok: true,
      result: { nodes: [{ id: 4, kind: "Harness", area: "Procedural", label: "k8s-debug" }] },
    }),
  });
  const res = await ensureHarnessIndexed(client as any, { name: "k8s-debug" });
  assert.deepEqual(res, { ok: true, node: 4, existed: true });
  assert.deepEqual(client.calls.map((c) => c.method), ["dump"], "no state round trip needed");
});

test("a located bundle matches an older node that has no location fact", async () => {
  // indexed before locations were recorded: no location fact -> match on label
  const client = recordingClient({
    dump: async () => ({
      ok: true,
      result: { nodes: [{ id: 4, kind: "Harness", area: "Procedural", label: "k8s-debug" }] },
    }),
    state: async () => ({ ok: true, result: { state: harnessState("k8s-debug", 4) } }),
  });
  const res = await ensureHarnessIndexed(client as any, bundle);
  assert.deepEqual(res, { ok: true, node: 4, existed: true });
});

test("a dead sidecar falls through to the create path, which reports its own error", async () => {
  // a failed lookup is "unknown", not a crash: the create path runs, and if
  // IT fails the failure is reported — never thrown through discovery
  const client = recordingClient({
    dump: async () => { throw new Error("memsrv crashed"); },
    create_node: async () => ({ ok: false, error: "create failed: journal read-only" }),
  });
  const res = await ensureHarnessIndexed(client as any, bundle);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /journal read-only/);
});

/** Minimal in-memory stand-in for memsrv: create/fact/dump/state only. */
function memFake(opts: { failCreate?: string } = {}) {
  const nodes = new Map<number, { kind: string; area: string; label: string; facts: Map<string, string> }>();
  let next = 1;
  const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
  return {
    nodes,
    async request(method: string, params: any = {}) {
      switch (method) {
        case "create_node": {
          if (opts.failCreate && params.label === opts.failCreate) {
            return { ok: false, error: `create failed for ${params.label} (fake)` };
          }
          const id = next++;
          nodes.set(id, {
            kind: params.kind, area: params.area ?? "semantic", label: params.label,
            facts: new Map(),
          });
          return { ok: true, result: { node: id } };
        }
        case "fact": {
          nodes.get(params.node)?.facts.set(params.key, params.value);
          return { ok: true, result: { fact: 99 } };
        }
        case "dump": {
          return {
            ok: true,
            result: {
              nodes: [...nodes.entries()].map(([id, n]) => ({
                id, kind: cap(n.kind), area: cap(n.area), label: n.label,
              })),
            },
          };
        }
        case "state": {
          const n = nodes.get(params.node);
          if (!n) return { ok: false, error: `node ${params.node} missing` };
          const facts = [...n.facts.entries()].map(([k, v]) => `  - ${k}: ${v}`).join("\n");
          return {
            ok: true,
            result: { state: `[${cap(n.kind)}/${cap(n.area)}] ${n.label} #${params.node}\nfacts:\n${facts}` },
          };
        }
        default:
          return { ok: true, result: {} };
      }
    },
  };
}

test("discovering the same bundle twice creates one Harness node, not two", async () => {
  const mem = memFake();
  const pass1 = await indexDiscoveredHarnesses(mem as any, [bundle]);
  assert.deepEqual(pass1, { created: 1, existing: 0, failed: [] });
  const pass2 = await indexDiscoveredHarnesses(mem as any, [bundle]);
  assert.deepEqual(pass2, { created: 0, existing: 1, failed: [] });

  const harness = [...mem.nodes.values()].filter(
    (n) => n.kind === "harness" && n.label === "k8s-debug",
  );
  assert.equal(harness.length, 1, "exactly one Harness node after two passes");
  assert.equal(harness[0].facts.get("location"), bundle.dir);
});

test("one unindexable bundle does not stop the discovery pass", async () => {
  const mem = memFake({ failCreate: "k8s-debug" });
  const good: HarnessIndexInput = { name: "good-bin", description: "works" };
  const res = await indexDiscoveredHarnesses(mem as any, [bundle, good]);
  assert.equal(res.created, 1);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0], /k8s-debug/);
  assert.ok([...mem.nodes.values()].some((n) => n.label === "good-bin"),
    "the good bundle was still indexed");
});

const MemsrvBin = process.env.MNEMO_MEMSRV_BIN
  ?? path.join(fileURLToPath(new URL("../..", import.meta.url)), "memory-layer", "target", "debug", "memsrv");

test("a real memsrv: re-indexing reuses the node; a path move is a new bundle; purpose recalls it", async () => {
  const { MemClient } = await import("../extensions/memory-layer.ts");
  const journal = path.join(TMP, "fn-journal.jsonl");
  const client = new MemClient({ journalPath: journal, binaryPath: MemsrvBin });
  try {
    const b: HarnessIndexInput = {
      name: "night-deploy",
      description: "deploy to production inside a canary window at night",
      tools: ["deploy_canary"],
      dir: "/tmp/skills/night-deploy",
    };
    const r1 = await ensureHarnessIndexed(client as any, b);
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    const first = r1.node;

    const r2 = await ensureHarnessIndexed(client as any, b);
    assert.deepEqual(r2, { ok: true, node: first, existed: true },
      "second index of the same identity reuses the node");

    const moved = await ensureHarnessIndexed(client as any, { ...b, dir: "/elsewhere/night-deploy" });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    assert.notEqual(moved.node, first, "a different path is a different bundle");

    const dump = await client.request("dump");
    const harnesses = dump.result.nodes.filter(
      (n: any) => n.kind === "Harness" && n.label === "night-deploy",
    );
    assert.equal(harnesses.length, 2, "two distinct identities, two nodes");

    const hit = await client.request("search", { query: "deploy to production at night", k: 3 });
    const labels = hit.result.results.map((r: any) => r.label);
    assert.ok(labels.includes("night-deploy"),
      `purpose must recall the harness, got: ${labels.join(", ")}`);
  } finally {
    client.stop();
  }
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));