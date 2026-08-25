/** Skill bundles: write, read, validate, and import tool files (with cache busting). */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  BundleManifest,
  Disposable,
  ScopeName,
  ToolDefinition,
  ToolModule,
  ToolSchema,
} from "./types.ts";
import { checkToolSource, validateToolShape, type SafetyOptions } from "./safety.ts";

let loadNonce = 0;

export interface BundleToolSpec {
  name: string;
  description?: string;
  schema: ToolSchema;
  /**
   * Tool source. Two accepted forms:
   *  1. full ES module: contains `export default` -> written verbatim;
   *     the default export must satisfy ToolDefinition.
   *  2. execute body: any other JS -> wrapped into a generated default export
   *     as the body of `async execute(params) {...}`.
   */
  source: string;
}

export interface BundleSpec {
  name: string;
  version?: string;
  description: string;
  tools: BundleToolSpec[];
}

export interface LoadedBundle {
  /** Stable id: "<manifest.name>@<version>". */
  id: string;
  dir: string;
  manifest: BundleManifest;
  scope: ScopeName | null;
  tools: Map<string, ToolDefinition>;
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

export function assertValidSpec(spec: BundleSpec): void {
  if (!spec || typeof spec !== "object") throw new Error("bundle spec must be an object");
  if (!NAME_RE.test(spec.name)) throw new Error(`invalid bundle name "${spec?.name}"`);
  for (const t of spec.tools ?? []) {
    if (!NAME_RE.test(t.name)) throw new Error(`invalid tool name "${t?.name}"`);
    if (!t.schema || typeof t.schema !== "object" || (t.schema as ToolSchema).type !== "object") {
      throw new Error(`tool "${t.name}": schema object with type:"object" is required`);
    }
    if (typeof t.source !== "string" || t.source.trim() === "") {
      throw new Error(`tool "${t.name}": non-empty source string is required`);
    }
  }
}

function renderToolFile(tool: BundleToolSpec): string {
  const hasDefaultExport = /(^|[;\n}])\s*export\s+default\s/.test(tool.source);
  if (hasDefaultExport) return tool.source; // full-module form, verbatim
  // execute-body form
  return [
    `export default {`,
    `  name: ${JSON.stringify(tool.name)},`,
    `  description: ${JSON.stringify(tool.description ?? "")},`,
    `  schema: ${JSON.stringify(tool.schema, null, 2)},`,
    `  async execute(params) {`,
    tool.source
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
    `  },`,
    `};`,
    ``,
  ].join("\n");
}

/** Write a bundle folder under `root`. Returns the bundle directory. */
export async function writeBundle(root: string, spec: BundleSpec): Promise<string> {
  assertValidSpec(spec);
  const dir = path.join(root, spec.name);
  await fs.mkdir(path.join(dir, "tools"), { recursive: true });
  const manifest: BundleManifest = {
    name: spec.name,
    version: spec.version ?? "0.1.0",
    description: spec.description ?? "",
    tools: spec.tools.map((t) => `tools/${t.name}.mjs`),
  };
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  for (const tool of spec.tools) {
    await fs.writeFile(path.join(dir, manifest.tools[spec.tools.indexOf(tool)]!), renderToolFile(tool), "utf8");
  }
  return dir;
}

/**
 * Import one tool file. A unique query nonce per call means every load gets a
 * fresh module instance; unregistering a bundle drops the only strong
 * reference, so stale modules become garbage-collectable (ESM caches are not
 * mutable, so this is the honest way to "drop cached imports").
 */
export async function importToolFile(fileAbsPath: string): Promise<ToolModule> {
  const url = pathToFileURL(fileAbsPath).href + `?harness-nonce=${++loadNonce}`;
  return (await import(/* @vite-ignore */ url)) as ToolModule;
}

/** Read + load a bundle directory. Throws on invalid manifests/tools/broken sources. */
export async function loadBundle(dir: string, scope: ScopeName | null = null): Promise<LoadedBundle> {
  const manifestPath = path.join(dir, "manifest.json");
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as BundleManifest;
  if (!NAME_RE.test(String(raw?.name))) throw new Error(`${manifestPath}: invalid or missing name`);
  if (!Array.isArray(raw?.tools) || raw.tools.length === 0) {
    throw new Error(`${manifestPath}: "tools" must be a non-empty array of file refs`);
  }
  const manifest: BundleManifest = {
    name: raw.name,
    version: String(raw.version ?? "0.0.0"),
    description: String(raw.description ?? ""),
    tools: raw.tools.map(String),
  };
  const tools = new Map<string, ToolDefinition>();
  for (const ref of manifest.tools) {
    const fileAbs = path.resolve(dir, ref);
    let mod: ToolModule;
    try {
      mod = await importToolFile(fileAbs);
    } catch (err) {
      throw new Error(`bundle "${manifest.name}": failed to load ${ref}: ${(err as Error).message}`);
    }
    const shapeIssues = validateToolShape(mod?.default, `${manifest.name}/${ref}`);
    if (shapeIssues.length > 0) {
      throw new Error(`bundle "${manifest.name}": ${shapeIssues.map((i) => i.message).join("; ")}`);
    }
    const tool = mod.default as ToolDefinition;
    if (tools.has(tool.name)) {
      throw new Error(`bundle "${manifest.name}": duplicate tool name "${tool.name}"`);
    }
    tools.set(tool.name, tool);
  }
  return {
    id: `${manifest.name}@${manifest.version}`,
    dir: path.resolve(dir),
    manifest,
    scope,
    tools,
  };
}
