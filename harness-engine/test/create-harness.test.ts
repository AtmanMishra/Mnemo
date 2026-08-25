import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ToolRegistry } from "../src/registry.ts";
import { createHarness } from "../src/create-harness.ts";
import { makeTmpDir, moduleSource } from "./helpers.ts";

test("createHarness writes, validates, registers and disposes", async () => {
  const root = await makeTmpDir();
  const registry = new ToolRegistry();

  const result = await createHarness({
    registry,
    root,
    spec: {
      name: "math-kit",
      description: "tiny math tools",
      tools: [
        {
          name: "double",
          description: "double a number",
          schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
          // execute-body form: source becomes the body of execute(params)
          source: "return String(Number(params.n) * 2);",
        },
        {
          name: "square",
          schema: { type: "object", properties: { n: { type: "number" } } },
          // full-module form
          source: moduleSource({ name: "square", returns: "String(params.n ** 2)" }),
        },
      ],
    },
    scope: "session",
  });

  assert.match(result.bundleId, /^math-kit@/);
  assert.deepEqual(result.tools.sort(), ["double", "square"]);
  // Bundle folder exists on disk with manifest + tool files.
  const manifest = JSON.parse(await fs.readFile(path.join(result.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.name, "math-kit");
  assert.equal(manifest.tools.length, 2);
  await fs.access(path.join(result.dir, "tools/double.mjs"));

  // Tools are callable immediately.
  assert.equal(await registry.resolve("double")!.tool.execute({ n: 21 }), "42");
  assert.equal(await registry.resolve("square")!.tool.execute({ n: 7 }), "49");

  // Dispose unregisters.
  await result.disposable.dispose();
  assert.equal(registry.resolve("double"), undefined);

  await fs.rm(root, { recursive: true, force: true });
});

test("createHarness rolls back the folder when load fails", async () => {
  const root = await makeTmpDir();
  const registry = new ToolRegistry();
  await assert.rejects(
    () =>
      createHarness({
        registry,
        root,
        spec: {
          name: "bad-bundle",
          description: "",
          tools: [
            {
              name: "broken",
              schema: { type: "object" },
              source: moduleSource({ name: "other-name", returns: "'x'" }), // declared != loaded
            },
          ],
        },
      }),
    /missing from loaded bundle/,
  );
  await assert.rejects(() => fs.access(path.join(root, "bad-bundle")), /ENOENT/);
  await fs.rm(root, { recursive: true, force: true });
});

test("createHarness enforces the safety gate before writing anything", async () => {
  const root = await makeTmpDir();
  const registry = new ToolRegistry();
  await assert.rejects(
    () =>
      createHarness({
        registry,
        root,
        spec: {
          name: "shell-kit",
          description: "tries to escape",
          tools: [
            {
              name: "run",
              schema: { type: "object", properties: { cmd: { type: "string" } } },
              source: `
                import { execSync } from "child_process";
                export default { name: "run", schema: { type: "object" },
                  async execute(p) { return execSync(p.cmd).toString(); } };
              `,
            },
          ],
        },
      }),
    /safety gate.*child_process/,
  );
  await assert.rejects(() => fs.access(path.join(root, "shell-kit")), /ENOENT/);

  // allowModules opens a specific hole:
  const ok = await createHarness({
    registry,
    root,
    spec: {
      name: "fs-lite",
      description: "",
      tools: [
        {
          name: "cwd",
          schema: { type: "object" },
          source: `
            import { cwd } from "node:process";
            export default { name: "cwd", schema: { type: "object" },
              async execute() { return cwd(); } };
          `,
        },
      ],
    },
    safety: { allowModules: ["node:process"] },
  });
  assert.ok(registry.resolve("cwd"));
  await ok.disposable.dispose();

  await fs.rm(root, { recursive: true, force: true });
});

test("createHarness rejects missing schemas and empty tool lists", async () => {
  const root = await makeTmpDir();
  const registry = new ToolRegistry();
  await assert.rejects(
    () =>
      createHarness({
        registry,
        root,
        spec: {
          name: "no-schema",
          description: "",
          tools: [{ name: "t", schema: undefined as never, source: "return 1;" }],
        },
      }),
    /schema/,
  );
  await assert.rejects(
    () => createHarness({ registry, root, spec: { name: "empty", description: "", tools: [] } }),
    /non-empty/,
  );
  await fs.rm(root, { recursive: true, force: true });
});
