import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ToolRegistry } from "../src/registry.ts";
import { loadBundle } from "../src/bundle.ts";
import { makeTmpDir, writeBundleDir } from "./helpers.ts";

test("bundle load + dispose roundtrip drops tools and cached modules", async () => {
  const root = await makeTmpDir();
  const dir = await writeBundleDir(root, "greet-bundle", [
    { name: "greet" },
    { name: "shout" },
  ]);

  const registry = new ToolRegistry();
  const first = await loadBundle(dir, "session");
  assert.equal(first.id, "greet-bundle@0.1.0");
  assert.deepEqual([...first.tools.keys()].sort(), ["greet", "shout"]);

  const disposable = registry.register(first, "session");
  assert.equal(await registry.resolve("greet")!.tool.execute({}), "ran:greet-bundle:greet");

  // Fresh import of the same files yields a NEW module instance (cache busted),
  // proving re-registration does not reuse stale module state.
  const second = await loadBundle(dir, "session");
  assert.notEqual(first.tools.get("greet"), second.tools.get("greet"));

  await disposable.dispose();
  assert.equal(registry.resolve("greet"), undefined);
  assert.equal(registry.resolve("shout"), undefined);
  assert.equal(registry.list().length, 0);

  // Disposable is idempotent.
  await disposable.dispose();

  // And we can register again cleanly.
  const d2 = registry.register(second, "session");
  assert.equal(registry.resolve("greet")?.scope, "session");
  await d2.dispose();

  await fs.rm(root, { recursive: true, force: true });
});

test("loadBundle rejects broken sources and invalid manifests", async () => {
  const root = await makeTmpDir();

  // syntax error in tool file
  const bad1 = await writeBundleDir(root, "broken-syntax", [{ name: "x" }]);
  await fs.writeFile(
    path.join(bad1, "tools/x.mjs"),
    "export default { name: 'x', schema: {type:'object'}, execute: () => {{{",
    "utf8",
  );
  await assert.rejects(() => loadBundle(bad1), /failed to load/);

  // missing execute
  const bad2 = await writeBundleDir(root, "no-execute", [{ name: "y" }]);
  await fs.writeFile(
    path.join(bad2, "tools/y.mjs"),
    "export default { name: 'y', schema: { type: 'object' } };",
    "utf8",
  );
  await assert.rejects(() => loadBundle(bad2), /missing "execute"/);

  // missing manifest
  await assert.rejects(() => loadBundle(path.join(root, "does-not-exist")));

  await fs.rm(root, { recursive: true, force: true });
});
