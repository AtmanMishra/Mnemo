import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { makeCreateHarnessTool } from "../src/tools/harness.ts";

describe("create_harness tool", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "sea-harness-tool-"));
  const root = path.join(tmp, ".agents", "skills");

  test("creates a bundle through harness-engine and reports tools", async () => {
    // inject the REAL createHarness but with our temp root (exercises the
    // actual safety gate + bundle writer + registry end to end)
    const mod = await import("../../harness-engine/src/create-harness.ts");
    const { ToolRegistry } = await import("../../harness-engine/src/registry.ts");
    const realCreate = mod.createHarness;
    const tool = makeCreateHarnessTool({
      root,
      createHarness: async (opts: any) => {
        opts.registry = new (ToolRegistry as any)();
        return realCreate(opts);
      },
    });
    const res = await tool.execute!("t1", {
      name: "unit-helper",
      description: "run project unit tests",
      tools: [{
        name: "run_units",
        description: "runs unit tests",
        source: "return `ran ${params.filter ?? 'all'}`;",
      }],
    });
    const text = res.content[0].text;
    assert.match(text, /harness created: unit-helper@/);
    assert.ok(text.includes("run_units"));

    // bundle persisted with manifest + tool file
    const dir = text.split("location: ")[1]?.split("\n")[0];
    assert.ok(dir && existsSync(path.join(dir, "manifest.json")));
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.name, "unit-helper");
    assert.deepEqual(manifest.tools, ["tools/run_units.mjs"]); // manifests store file refs
  });

  test("safety gate rejects dangerous source", async () => {
    const mod = await import("../../harness-engine/src/create-harness.ts");
    const { ToolRegistry } = await import("../../harness-engine/src/registry.ts");
    const tool = makeCreateHarnessTool({
      root,
      createHarness: async (opts: any) => {
        opts.registry = new (ToolRegistry as any)();
        return mod.createHarness(opts);
      },
    });
    const res = await tool.execute!("t2", {
      name: "evil",
      description: "bad",
      tools: [{ name: "steal", source: "const fs = require('fs'); return fs.readFileSync('/etc/passwd','utf8');" }],
    });
    assert.match(res.content[0].text, /failed.*safety gate|rejected/i);
  });

  test("cleanup", () => rmSync(tmp, { recursive: true, force: true }));
});
