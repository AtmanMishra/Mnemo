/**
 * sea-tools-inline adapter tests: every sea tool must register through a
 * fake ExtensionAPI, with names preserved and executable execute() functions.
 */
import { test } from "node:test";
import assert from "node:assert";
import { SEA_TOOL_NAMES, seaToolsInline, seaToolsFactory, toToolDefinition } from "../extensions/sea-tools-inline.ts";

const EXPECTED = [
  "bash_exec",
  "read_file",
  "write_file",
  "apply_edit",
  "glob_list",
  "ipy_run",
  "list_skills",
  "load_skill",
  "create_skill",
  "patch_skill",
  "retire_skill",
  "create_harness",
  "spawn_subagent",
  "memory_search",
  "memory_write_fact",
  "memory_steer",
  "web_fetch",
  "web_search",
  "read_image",
];

function fakePi() {
  const registered: any[] = [];
  const handlers: Record<string, any[]> = {};
  return {
    registered,
    handlers,
    on(event: string, fn: any) {
      (handlers[event] ??= []).push(fn);
    },
    registerTool(tool: any) {
      registered.push(tool);
    },
    getAllTools: () => [] as any[],
  };
}

test("registers exactly the sea tools, with stable names", () => {
  const pi = fakePi();
  pi.getAllTools = () => [];
  seaToolsFactory(pi);
  // web tools defer to session_start (a runtime package like pi-web-access
  // may already own the names, and a duplicate would kill the extension load)
  const deferred = (n: string) => n === "web_search" || n === "web_fetch";
  assert.deepEqual(
    pi.registered.map((t) => t.name).sort(),
    [...EXPECTED.filter((n) => !deferred(n))].sort(),
  );
  for (const fn of pi.handlers.session_start ?? []) fn();
  assert.deepEqual(
    pi.registered.map((t) => t.name).sort(),
    [...EXPECTED].sort(),
    "session_start claims the web tools when nobody else owns them",
  );
});

test("web tools defer to an existing runtime tool instead of conflicting", () => {
  const pi = fakePi();
  // pi-web-access-style runtime: the names are already taken
  pi.getAllTools = () => [{ name: "web_search" }, { name: "web_fetch" }];
  seaToolsFactory(pi);
  for (const fn of pi.handlers.session_start ?? []) fn();
  assert.ok(
    !pi.registered.some((t) => t.name === "web_search"),
    "must not register a web_search that conflicts with the runtime's",
  );
  assert.ok(!pi.registered.some((t) => t.name === "web_fetch"));
});

test("SEA_TOOL_NAMES matches registered names", () => {
  assert.deepEqual([...SEA_TOOL_NAMES].sort(), [...EXPECTED].sort());
});

test("named InlineExtension shape exposes factory", () => {
  assert.equal((seaToolsInline as any).name, "sea-tools");
  assert.equal(typeof (seaToolsInline as any).factory, "function");
});

test("each definition has label/description/parameters/execute", () => {
  const pi = fakePi();
  seaToolsFactory(pi);
  for (const t of pi.registered) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.label, "string");
    assert.ok(t.description.length > 0, `${t.name} needs a description`);
    assert.ok(t.parameters, `${t.name} needs parameters`);
    assert.equal(typeof t.execute, "function");
  }
});

test("adapter execute() returns the tool result content", async () => {
  const pi = fakePi();
  seaToolsFactory(pi);
  const glob = pi.registered.find((t) => t.name === "glob_list");
  const res = await glob.execute("test-id", { pattern: "*.nonexistent-zz" });
  assert.ok(Array.isArray(res.content));
  assert.equal(res.content[0].type, "text");
});

test("adapter forwards pi's 5th-argument context to the tool (D6)", async () => {
  // The context is how a tool learns the live session (PI_* child env) and
  // whether a dialog UI exists, so losing it here would silently break both.
  const seen: unknown[] = [];
  const def = toToolDefinition({
    name: "spy", label: "spy", description: "d", parameters: {},
    execute: async (_id: string, _params: any, _signal?: unknown, _onUpdate?: unknown, ctx?: unknown) => {
      seen.push(ctx);
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const ctx = { hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => "s" } };
  const res = await def.execute("id", { x: 1 }, undefined, undefined, ctx);
  assert.equal(seen[0], ctx);
  assert.equal(res.content[0].text, "ok");
});
