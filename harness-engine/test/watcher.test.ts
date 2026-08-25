import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ToolRegistry } from "../src/registry.ts";
import { SkillsWatcher } from "../src/watcher.ts";
import { makeTmpDir, writeBundleDir, waitFor } from "./helpers.ts";

function setup(root: string) {
  const registry = new ToolRegistry();
  const watcher = new SkillsWatcher(registry, [{ path: root, scope: "project" }], {
    debounceMs: 250,
  });
  return { registry, watcher };
}

test("watched-dir pickup latency < 1s", async () => {
  const root = await makeTmpDir();
  const { registry, watcher } = setup(root);
  watcher.start();
  try {
    const t0 = Date.now();
    await writeBundleDir(root, "late-bundle", [
      { name: "hello", source: 'export default { name:"hello", schema:{type:"object"}, async execute(){ return "hi"; } };' },
    ]);
    const elapsed = await waitFor(() => registry.resolve("hello") !== undefined, 1000);
    assert.ok(elapsed < 1000, `pickup took ${elapsed}ms`);
    assert.equal(await registry.resolve("hello")!.tool.execute({}), "hi");
    assert.equal(registry.resolve("hello")?.scope, "project");
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rewriting a tool file invalidates and reloads the bundle", async () => {
  const root = await makeTmpDir();
  const { registry, watcher } = setup(root);
  watcher.start();
  try {
    // v1
    await writeBundleDir(root, "counter", [
      { name: "value", source: 'export default { name:"value", schema:{type:"object"}, async execute(){ return "v1"; } };' },
    ]);
    await waitFor(() => registry.resolve("value") !== undefined, 1000);
    assert.equal(await registry.resolve("value")!.tool.execute({}), "v1");

    // rewrite -> invalidate + reload with a fresh module (no stale import cache)
    await fs.writeFile(
      path.join(root, "counter", "tools", "value.mjs"),
      'export default { name:"value", schema:{type:"object"}, async execute(){ return "v2"; } };',
      "utf8",
    );
    await waitFor(async () => (await registry.resolve("value")!.tool.execute({})) === "v2", 1000);

    // broken rewrite -> bundle invalidated (old version dropped, not kept stale)
    await fs.writeFile(
      path.join(root, "counter", "tools", "value.mjs"),
      "export default { name:'value', oops",
      "utf8",
    );
    await waitFor(() => registry.resolve("value") === undefined, 1000);
    assert.ok(watcher.errors.length > 0, "expected an invalidation error recorded");
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deleting a bundle directory unregisters it", async () => {
  const root = await makeTmpDir();
  const { registry, watcher } = setup(root);
  watcher.start();
  try {
    const dir = await writeBundleDir(root, "doomed", [{ name: "gone" }]);
    await waitFor(() => registry.resolve("gone") !== undefined, 1000);
    await fs.rm(dir, { recursive: true, force: true });
    await waitFor(() => registry.resolve("gone") === undefined, 1000);
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
