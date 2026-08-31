/**
 * AREA 9.6 — hooks in memory. First half: fake-client pattern (the RPC shape,
 * idempotency, failure tolerance are under test). Last test drives a REAL
 * memsrv over a temp journal and searches the hook back from its purpose —
 * deterministic hashing embedder (no remote key), mirroring
 * harness_memory.test.ts.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HookMemsrvClient, ensureHookIndexed, findHookNode, factsFromState,
  indexHooksToMemory, indexInputFor, syncHooksToMemory, type HookIndexInput,
} from "../src/hooks/memory.ts";
import type { Hook } from "../src/hooks/types.ts";

let counter = 0;

/** Records every request a fake client receives. */
function recordingClient(overrides: Record<string, (p: any) => any> = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    calls,
    async request(method: string, params: any = {}) {
      calls.push({ method, params });
      const handler = overrides[method] ?? ((p: any) => {
        if (method === "create_node") return { ok: true, result: { node: 41 } };
        if (method === "fact") return { ok: true, result: { fact: 7 } };
        if (method === "dump") return { ok: true, result: { nodes: [] } };
        return { ok: true, result: {} };
      });
      return handler(params);
    },
  };
  return client;
}

function hook(over: Partial<Hook> = {}): Hook {
  return {
    id: "audit.store-writes",
    trigger: "PreToolUse",
    command: "./bin/audit.sh",
    matcher: { tool: "write_file|apply_edit", path: "src/**" },
    description: "audit writes to src",
    scope: "project",
    file: "/repo/.mnemo/hooks/audit.store-writes.json",
    ...over,
  };
}

test("an empty-memsrv fake gets the exact create_node + fact RPC shape", async () => {
  const client = recordingClient();
  const res = await ensureHookIndexed(client as any, indexInputFor(hook()));
  assert.deepEqual(res, { ok: true, node: 41, existed: false });
  // idempotent lookup first (dump), then the create
  assert.equal(client.calls[0].method, "dump");
  assert.deepEqual(client.calls[1], {
    method: "create_node",
    params: { kind: "harness", area: "procedural", label: "hook:audit.store-writes" },
  });
  const facts = client.calls.slice(2).map((c) => c.params);
  assert.deepEqual(facts, [
    { node: 41, key: "role", value: "hook" },
    { node: 41, key: "trigger", value: "PreToolUse" },
    { node: 41, key: "matcher", value: "tool=write_file|apply_edit path=src/**" },
    { node: 41, key: "scope", value: "project" },
    { node: 41, key: "description", value: "audit writes to src" },
    { node: 41, key: "location", value: "/repo/.mnemo/hooks/audit.store-writes.json" },
  ], "hooks carry hook-specific facts, distinct from real harness bundles");
});

test("re-syncing the same hook dedupes on (label, location)", async () => {
  const repo = {
    nodes: [{ id: 3, kind: "Harness", area: "Procedural", label: "hook:audit.store-writes" }],
  };
  const client = recordingClient({
    dump: () => ({ ok: true, result: repo }),
    state: () => ({
      ok: true,
      result: { state: "  - role: hook\n  - trigger: PreToolUse\n  - location: /repo/.mnemo/hooks/audit.store-writes.json" },
    }),
  });
  const input = indexInputFor(hook());
  const found = await findHookNode(client as any, input);
  assert.equal(found, 3);
  const res = await ensureHookIndexed(client as any, input);
  assert.deepEqual(res, { ok: true, node: 3, existed: true });
  // no create_node/fact calls were made
  assert.ok(client.calls.every((c) => c.method !== "create_node" && c.method !== "fact"));
});

test("a hook without a location matches a name-only node by label", async () => {
  const client = recordingClient({
    dump: () => ({ ok: true, result: { nodes: [{ id: 9, kind: "Harness", area: "Procedural", label: "hook:bare" }] } }),
  });
  const found = await findHookNode(client as any, indexInputFor(hook({ id: "bare", file: undefined, location: "" } as any)));
  assert.equal(found, 9);
});

test("a changed location is a NEW hook identity (no stale dedupe)", async () => {
  const client = recordingClient({
    dump: () => ({ ok: true, result: { nodes: [{ id: 3, kind: "Harness", area: "Procedural", label: "hook:audit.store-writes" }] } }),
    state: () => ({
      ok: true,
      result: { state: "  - location: /elsewhere/hooks/audit.store-writes.json" },
    }),
  });
  const found = await findHookNode(client as any, indexInputFor(hook()));
  assert.equal(found, null, "different location -> not the same node");
});

test("indexHooksToMemory counts created/existing/failed and never throws per hook", async () => {
  const client = recordingClient({
    dump: () => ({ ok: true, result: { nodes: [{ id: 1, kind: "Harness", area: "Procedural", label: "hook:already" }] } }),
    create_node: () => ({ ok: false, error: "disk full" }),
  });
  const lines: string[] = [];
  const counts = await indexHooksToMemory(client as any, [
    hook({ id: "already", file: "" } as any),
    hook({ id: "bad", file: "/x/hook.json" }),
  ], (l) => lines.push(l));
  assert.equal(counts.created, 0);
  assert.equal(counts.existing, 1, "already -> existing");
  assert.equal(counts.failed.length, 1, "bad survived a create_node failure, reported not thrown");
});

test("factsFromState understands the memsrv state rendering", () => {
  const m = factsFromState("  - role: hook\n  - trigger: PostToolUse\n  - location: /a/b.json");
  assert.equal(m.get("role"), "hook");
  assert.equal(m.get("trigger"), "PostToolUse");
  assert.equal(m.get("location"), "/a/b.json");
});

test("syncHooksToMemory swallows a dead sidecar", async () => {
  const dead = { request: async () => { throw new Error("memsrv crashed"); } };
  const counts = await syncHooksToMemory(dead as any, [hook()], () => {});
  assert.equal(counts.failed.length, 1);
  assert.equal(counts.created + counts.existing, 0);
});

// --- real memsrv over a temp journal ------------------------------------------

const clients: HookMemsrvClient[] = [];

after(() => {
  for (const c of clients) c.stop();
});

test("a real memsrv indexes a hook and recalls it from its purpose", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-hooks-mem-${counter++}-`));
  const client = new HookMemsrvClient({ journalPath: path.join(dir, "journal.jsonl") });
  clients.push(client);
  try {
    const sync = await syncHooksToMemory(client, [
      hook({
        id: "freeze-rollout",
        trigger: "PreToolUse",
        matcher: { tool: "bash_exec" },
        description: "block helm rollouts during the freeze window",
        scope: "project",
        file: "/repo/.mnemo/hooks/freeze-rollout.json",
      }),
    ]);
    assert.equal(sync.created, 1);
    assert.deepEqual(sync.failed, []);

    // the node exists with the right shape (dump: kind Harness, area Procedural)
    const dump = await client.request("dump");
    const node = dump.result.nodes.find((n: any) => n.label === "hook:freeze-rollout");
    assert.ok(node, "hook node present in dump");
    assert.equal(node.kind, "Harness");
    assert.equal(node.area, "Procedural");

    // and a procedural search finds it from its stated purpose
    const search = await client.request("search", { query: "block helm rollouts during the freeze window", k: 5 });
    const hits = search.result?.results ?? [];
    assert.ok(
      hits.some((h: any) => h.label === "hook:freeze-rollout" && h.kind === "Harness"),
      `procedural recall finds the hook by purpose; got: ${hits.map((h: any) => h.label).join(", ")}`,
    );

    // idempotent second sync
    const again = await syncHooksToMemory(client, [
      hook({
        id: "freeze-rollout",
        trigger: "PreToolUse",
        matcher: { tool: "bash_exec" },
        description: "block helm rollouts during the freeze window",
        scope: "project",
        file: "/repo/.mnemo/hooks/freeze-rollout.json",
      }),
    ]);
    assert.equal(again.created, 0);
    assert.equal(again.existing, 1, "second sync dedupes");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("extension-level sync after /hook add makes the new hook recallable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-hooks-add-${counter++}-`));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const client = new HookMemsrvClient({ journalPath: path.join(dir, "journal.jsonl") });
  clients.push(client);
  try {
    const runExtensionScene = async () => {
      const { HookEngine } = await import("../src/hooks/engine.ts");
      const { runHookCommand, tokenize } = await import("../src/hooks/commands.ts");
      const { projectHookRoot } = await import("../src/hooks/scanner.ts");
      fs.mkdirSync(home, { recursive: true });
      const engine = new HookEngine({ home });
      const ctx = {
        cwd: home, // project rooted at home is fine: .mnemo/hooks lives under it
        home,
        env: { ...process.env, HOME: home },
        ui: { notify: () => {} },
        engine,
      };
      const report = await runHookCommand(
        "add freeze --trigger PreToolUse --command bin/freeze.sh --scope user -y",
        ctx as any,
      );
      assert.ok(report.includes("written"), report);
      if (tokenize("add freeze --trigger PreToolUse --command bin/freeze.sh --scope user -y")[0] === "add") {
        // mirror the extension's post-add behavior
        await syncHooksToMemory(client as any, engine.registry(home).hooks());
      }
    };
    await runExtensionScene();
    const dump = await client.request("dump");
    const node = dump.result.nodes.find((n: any) => n.label === "hook:freeze");
    assert.ok(node, "the added hook is in memory");
    assert.equal(node.kind, "Harness");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
