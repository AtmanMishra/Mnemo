import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/registry.ts";
import { getLoaderTool } from "../src/loader-tool.ts";

function makeRegistryWithTools(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, tag] of [["alpha", "a"], ["beta", "b"]] as const) {
    registry.register(
      {
        id: `${name}@0.1.0`,
        dir: `/virtual/${name}`,
        manifest: { name, version: "0.1.0", description: "", tools: [`tools/${name}.mjs`] },
        scope: "session",
        execution: "in-process",
        tools: new Map([
          [
            name,
            {
              name,
              description: `tool ${tag}`,
              schema: { type: "object", properties: { x: { type: "string" } } },
              execute: async () => tag,
            },
          ],
        ]),
      },
      "session",
    );
  }
  return registry;
}

test("loader tool activates named tools lazily and returns schemas", async () => {
  const registry = makeRegistryWithTools();
  const loader = getLoaderTool(registry);

  assert.equal(loader.name, "load_tools");
  assert.equal(loader.schema.type, "object");
  assert.equal(registry.getActive().length, 0); // nothing active initially

  const out = JSON.parse(await loader.execute({ names: ["alpha", "ghost"] }));
  assert.equal(out.activated.length, 1);
  assert.equal(out.activated[0].name, "alpha");
  assert.equal(out.activated[0].schema.properties.x.type, "string");
  assert.deepEqual(out.missing, ["ghost"]);
  assert.deepEqual(out.activeTools, ["alpha"]);
  assert.ok(registry.isActive("alpha"));
  assert.ok(!registry.isActive("beta"));

  const out2 = JSON.parse(await loader.execute({ names: ["beta"] }));
  assert.deepEqual(out2.activeTools.sort(), ["alpha", "beta"]);

  // Disposing a bundle deactivates its tools too.
  registry.unregisterByDir("/virtual/alpha");
  assert.ok(!registry.isActive("alpha"));
});

test("loader tool input validation", async () => {
  const loader = getLoaderTool(makeRegistryWithTools());
  await assert.rejects(() => loader.execute({} as never), /names/);
  const out = JSON.parse(await loader.execute({ names: [] }));
  assert.deepEqual(out.activated, []);
});
