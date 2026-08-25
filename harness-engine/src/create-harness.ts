/**
 * harness_create: THE self-extension seam.
 * An LLM agent calls createHarness({name, description, tools:[{name, schema, source}]});
 * we validate + gate the source, write the bundle folder, load it, register it,
 * and hand back a Disposable. Nothing here executes tool code at creation time.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Disposable, ScopeName, ToolSchema } from "./types.ts";
import type { ToolRegistry } from "./registry.ts";
import { writeBundle, loadBundle, type BundleSpec } from "./bundle.ts";
import { checkToolSource } from "./safety.ts";

export interface HarnessToolSpec {
  name: string;
  description?: string;
  schema: ToolSchema;
  source: string;
}

export interface HarnessSpec {
  name: string;
  version?: string;
  description: string;
  tools: HarnessToolSpec[];
}

export interface CreateHarnessOptions {
  registry: ToolRegistry;
  /** Skills root directory the bundle is written to, e.g. <project>/skills. */
  root: string;
  spec: HarnessSpec;
  /** Registry scope to register at. Default "session". */
  scope?: ScopeName;
  safety?: { allowModules?: string[] };
}

export interface CreateHarnessResult {
  bundleId: string;
  disposable: Disposable;
  dir: string;
  tools: string[];
}

export async function createHarness(options: CreateHarnessOptions): Promise<CreateHarnessResult> {
  const { registry, root, spec } = options;
  if (!spec?.tools?.length) throw new Error("createHarness: spec.tools must be non-empty");

  // 1. Safety gate on raw source, before anything touches disk.
  for (const tool of spec.tools) {
    const report = checkToolSource(tool.source, options.safety);
    if (!report.ok) {
      const detail = report.issues.map((i) => `[${i.kind}] ${i.message}`).join("; ");
      throw new Error(`createHarness: tool "${tool.name}" rejected by safety gate: ${detail}`);
    }
  }

  // 2. Write the bundle to disk.
  const bundleSpec: BundleSpec = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    tools: spec.tools.map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.schema,
      source: t.source,
    })),
  };
  const dir = await writeBundle(root, bundleSpec);

  // 3. Load it. This compiles every tool file; failures roll back the folder.
  try {
    const bundle = await loadBundle(dir, null);
    // Cross-check declared vs loaded tool names so manifests can't lie.
    for (const t of spec.tools) {
      if (!bundle.tools.has(t.name)) {
        throw new Error(
          `tool "${t.name}" missing from loaded bundle ` +
            `(got: ${[...bundle.tools.keys()].join(", ") || "none"})`,
        );
      }
    }
    // 4. Register as an effect; caller owns the lifetime.
    const disposable = registry.register(bundle, options.scope ?? "session");
    return {
      bundleId: bundle.id,
      disposable,
      dir,
      tools: [...bundle.tools.keys()],
    };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}
