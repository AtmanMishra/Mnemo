import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { ToolRegistry } from "../src/registry.ts";
import { loadBundle } from "../src/bundle.ts";
import { makeTmpDir, writeBundleDir } from "./helpers.ts";

test("scope override precedence: session > project > global, with fallback", async () => {
  const root = await makeTmpDir();
  const registry = new ToolRegistry();

  // Same tool name in three bundles at three scopes.
  const mk = async (bundle: string, scope: "global" | "project" | "session", tag: string) => {
    const dir = await writeBundleDir(root, bundle, [
      { name: "echo", source: `export default { name:"echo", schema:{type:"object"}, async execute(){ return ${JSON.stringify(tag)}; } };` },
    ]);
    return registry.register(await loadBundle(dir, scope), scope);
  };

  const dGlobal = await mk("b-global", "global", "global");
  assert.equal(await registry.resolve("echo")!.tool.execute({}), "global");
  assert.equal(registry.resolve("echo")?.scope, "global");

  const dProject = await mk("b-project", "project", "project");
  assert.equal(registry.resolve("echo")?.scope, "project"); // project shadows global
  assert.equal(await registry.resolve("echo")!.tool.execute({}), "project");

  const dSession = await mk("b-session", "session", "session");
  assert.equal(registry.resolve("echo")?.scope, "session"); // session shadows all
  assert.equal(await registry.resolve("echo")!.tool.execute({}), "session");

  // list() shows exactly one visible entry (shadowed ones hidden)
  assert.equal(registry.list().filter((t) => t.name === "echo").length, 1);

  // Dispose nearest layer -> falls back to next layer
  await dSession.dispose();
  assert.equal(registry.resolve("echo")?.scope, "project");
  await dProject.dispose();
  assert.equal(registry.resolve("echo")?.scope, "global");
  await dGlobal.dispose();
  assert.equal(registry.resolve("echo"), undefined);

  await fs.rm(root, { recursive: true, force: true });
});

test("registering a same-name bundle into the same scope replaces the old one", async () => {
  const root = await makeTmpDir();
  const registry = new ToolRegistry();
  const dir1 = await writeBundleDir(root, "dup", [
    { name: "t", source: 'export default { name:"t", schema:{type:"object"}, async execute(){ return "v1"; } };' },
  ], "0.1.0");
  const dir2 = await writeBundleDir(root, "dup2-tmp", [], "0.1.0");
  await fs.rm(dir2, { recursive: true, force: true }); // just need a distinct dir path
  const dir3 = await writeBundleDir(root.replace(/dup2-tmp$/, "dup3"), "noop", [{ name: "noop" }]);

  const b1 = await loadBundle(dir1, "session");
  const disposable1 = registry.register(b1, "session");
  assert.equal(await registry.resolve("t")!.tool.execute({}), "v1");

  // Simulate a reload of the same bundle name from a rewritten dir.
  await fs.writeFile(
    dir1 + "/tools/t.mjs",
    'export default { name:"t", schema:{type:"object"}, async execute(){ return "v2"; } };',
    "utf8",
  );
  const b2 = await loadBundle(dir1, "session");
  const disposable2 = registry.register(b2, "session");
  assert.equal(await registry.resolve("t")!.tool.execute({}), "v2");

  // Old disposable is now inert; disposing it must not remove the new entry.
  await disposable1.dispose();
  assert.ok(registry.resolve("t"), "old dispose must not unregister replacement");
  await disposable2.dispose();
  assert.equal(registry.resolve("t"), undefined);

  void dir3;
  await fs.rm(root, { recursive: true, force: true });
});

test("shadowing a broader-scope tool is loud: event recorded + warning fired (b02291c2)", async () => {
  const root = await makeTmpDir();
  const events: import("../src/registry.ts").ShadowEvent[] = [];
  const registry = new ToolRegistry({ onShadowWarning: (e) => events.push(e) });

  const mk = async (bundle: string, scope: "global" | "project" | "session", toolName: string) => {
    const dir = await writeBundleDir(root, bundle, [
      { name: toolName, source: `export default { name:${JSON.stringify(toolName)}, schema:{type:"object"}, async execute(){ return "x"; } };` },
    ]);
    return registry.register(await loadBundle(dir, scope), scope);
  };

  // global tool, nothing shadowed
  const dg = await mk("g-bundle", "global", "shared");
  assert.equal(registry.shadowEvents.length, 0);
  assert.equal(events.length, 0);

  // DIFFERENT name at project scope: still silent
  await mk("p-clean", "project", "other");
  assert.equal(registry.shadowEvents.length, 0);

  // same name at project scope -> shadows global: event + warning
  const dp = await mk("p-bundle", "project", "shared");
  assert.equal(registry.shadowEvents.length, 1);
  assert.deepEqual(events[0]!.tools, ["shared"]);
  assert.equal(events[0]!.bundle, "p-bundle");
  assert.equal(events[0]!.scope, "project");
  // the shadowed tool still resolves to the nearest scope (design unchanged)
  assert.equal(registry.resolve("shared")?.scope, "project");

  // same name at session scope -> shadows project+global: one more event
  const ds = await mk("s-bundle", "session", "shared");
  assert.equal(registry.shadowEvents.length, 2);
  assert.deepEqual(events[1]!.tools, ["shared"]);
  assert.equal(events[1]!.scope, "session");

  // dispose nearest -> falls back, no new events
  await ds.dispose();
  assert.equal(registry.resolve("shared")?.scope, "project");
  await dp.dispose();
  await dg.dispose();
  assert.equal(events.length, 2, "no spurious events");

  await fs.rm(root, { recursive: true, force: true });
});
