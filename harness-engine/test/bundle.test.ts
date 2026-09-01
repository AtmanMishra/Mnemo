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

test("loadBundle gates on-disk sources on EVERY load path (ccdbbb2b/51b81dda)", async () => {
  const root = await makeTmpDir();

  // A bundle written straight to disk, bypassing createHarness entirely.
  // Before the fix, loadBundle imported whatever it found — gate never ran.
  const evil = await writeBundleDir(root, "evil-disk", [{ name: "boom" }]);
  await fs.writeFile(
    path.join(evil, "tools", "boom.mjs"),
    `import { execSync } from "node:child_process";\n` +
      `export default { name: "boom", schema: { type: "object" }, async execute(p) { return execSync(p.cmd).toString(); } };`,
    "utf8",
  );
  await assert.rejects(() => loadBundle(evil), /rejected by safety gate.*child_process/);

  // Backtick template specifier — invisible to the old quote-only regexes.
  const bt = await writeBundleDir(root, "backtick", [{ name: "bt" }]);
  await fs.writeFile(
    path.join(bt, "tools", "bt.mjs"),
    `export default { name: "bt", schema: { type: "object" }, ` +
      `async execute() { const m = await import(\`node:child_process\`); return typeof m; } };`,
    "utf8",
  );
  await assert.rejects(() => loadBundle(bt), /rejected by safety gate.*child_process/);

  // Computed specifier: non-literal requests are unverifiable => rejected.
  const comp = await writeBundleDir(root, "computed", [{ name: "comp" }]);
  await fs.writeFile(
    path.join(comp, "tools", "comp.mjs"),
    `export default { name: "comp", schema: { type: "object" }, ` +
      `async execute() { const m = await import(["child", "_process"].join("")); return typeof m; } };`,
    "utf8",
  );
  await assert.rejects(() => loadBundle(comp), /non-literal/);

  // Direct process access without any import.
  const proc = await writeBundleDir(root, "procaccess", [{ name: "pa" }]);
  await fs.writeFile(
    path.join(proc, "tools", "pa.mjs"),
    `export default { name: "pa", schema: { type: "object" }, ` +
      `async execute() { return process.env.HOME ?? "x"; } };`,
    "utf8",
  );
  await assert.rejects(() => loadBundle(proc), /process.*blocked/);

  await fs.rm(root, { recursive: true, force: true });
});

test("relative-import helper smuggling is caught at load (747c8c3b)", async () => {
  const root = await makeTmpDir();

  // Helper lives INSIDE the bundle dir; the tool file imports it relatively
  // and the helper does the real child_process work.
  const dir = await writeBundleDir(root, "helper-smuggle", [{ name: "front" }]);
  await fs.writeFile(
    path.join(dir, "tools", "evil-helper.mjs"),
    `import { execSync } from "node:child_process";\n` +
      `export const boom = (c) => execSync(c).toString();\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "tools", "front.mjs"),
    `import { boom } from "./evil-helper.mjs";\n` +
      `export default { name: "front", schema: { type: "object" }, async execute(p) { return boom(p.cmd); } };`,
    "utf8",
  );
  await assert.rejects(() => loadBundle(dir), /rejected by safety gate.*child_process/);

  // A CLEAN relative helper inside the bundle still works.
  const clean = await writeBundleDir(root, "helper-clean", [{ name: "front2" }]);
  await fs.writeFile(path.join(clean, "tools", "ok-helper.mjs"), `export const hi = () => "hi";\n`, "utf8");
  await fs.writeFile(
    path.join(clean, "tools", "front2.mjs"),
    `import { hi } from "./ok-helper.mjs";\n` +
      `export default { name: "front2", schema: { type: "object" }, async execute() { return hi(); } };`,
    "utf8",
  );
  const b = await loadBundle(clean);
  assert.equal(await b.tools.get("front2")!.execute({}), "hi");

  // Relative import resolving OUTSIDE the bundle dir is rejected.
  const esc = await writeBundleDir(root, "helper-escape", [{ name: "front3" }]);
  await fs.writeFile(path.join(root, "outside.mjs"), `export const x = 1;\n`, "utf8");
  await fs.writeFile(
    path.join(esc, "tools", "front3.mjs"),
    `import { x } from "../../outside.mjs";\n` +
      `export default { name: "front3", schema: { type: "object" }, async execute() { return String(x); } };`,
    "utf8",
  );
  await assert.rejects(() => loadBundle(esc), /outside the bundle directory/);

  await fs.rm(root, { recursive: true, force: true });
});

test("manifest tool refs must stay inside the bundle dir (dcd8c081)", async () => {
  const root = await makeTmpDir();

  // ".." traversal ref, target file actually exists at the bundle root.
  const trav = await writeBundleDir(root, "traversal", [{ name: "x" }]);
  await fs.writeFile(
    path.join(trav, "evil.mjs"),
    `export default { name: "x", schema: { type: "object" }, async execute() { return "evil"; } };`,
    "utf8",
  );
  const manifest = JSON.parse(await fs.readFile(path.join(trav, "manifest.json"), "utf8"));
  manifest.tools = ["tools/../evil.mjs"];
  await fs.writeFile(path.join(trav, "manifest.json"), JSON.stringify(manifest), "utf8");
  await assert.rejects(() => loadBundle(trav), /must not traverse|outside the bundle dir/);

  // Absolute ref outside the bundle.
  const abs = await writeBundleDir(root, "absref", [{ name: "x" }]);
  const outside = path.join(root, "outsider.mjs");
  await fs.writeFile(
    outside,
    `export default { name: "x", schema: { type: "object" }, async execute() { return "out"; } };`,
    "utf8",
  );
  const m2 = JSON.parse(await fs.readFile(path.join(abs, "manifest.json"), "utf8"));
  m2.tools = [outside];
  await fs.writeFile(path.join(abs, "manifest.json"), JSON.stringify(m2), "utf8");
  await assert.rejects(() => loadBundle(abs), /must be relative|outside the bundle dir/);

  // Symlinked tool file pointing outside the bundle dir.
  const sym = await writeBundleDir(root, "symlinked", [{ name: "x" }]);
  const target = path.join(root, "linked-target.mjs");
  await fs.writeFile(
    target,
    `export default { name: "x", schema: { type: "object" }, async execute() { return "linked"; } };`,
    "utf8",
  );
  await fs.rm(path.join(sym, "tools", "x.mjs"));
  await fs.symlink(target, path.join(sym, "tools", "x.mjs"));
  await assert.rejects(() => loadBundle(sym), /symlink escape|outside the bundle dir/);

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
  await assert.rejects(() => loadBundle(bad1), /failed to load|rejected by safety gate/);

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
