/**
 * sea-tools-inline adapter tests: every sea tool must register through a
 * fake ExtensionAPI, with names preserved and executable execute() functions.
 */
import { test } from "node:test";
import assert from "node:assert";
import { SEA_TOOL_NAMES, seaToolsInline, seaToolsFactory } from "../extensions/sea-tools-inline.ts";

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
  };
}

test("registers exactly the sea tools, with stable names", () => {
  const pi = fakePi();
  seaToolsFactory(pi);
  assert.deepEqual(
    pi.registered.map((t) => t.name).sort(),
    [...EXPECTED].sort(),
  );
  assert.equal(pi.registered.length, EXPECTED.length);
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
