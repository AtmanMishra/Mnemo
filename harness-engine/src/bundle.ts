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
import {
  checkToolSource,
  isWithin,
  validateToolShape,
  type SafetyOptions,
} from "./safety.ts";
import {
  describeBoundedFailure,
  runInChild,
  type BoundaryOptions,
  type ChildToolDescription,
} from "./boundary.ts";

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
  /** Real (canonical) bundle directory — symlinks resolved. */
  dir: string;
  manifest: BundleManifest;
  scope: ScopeName | null;
  tools: Map<string, ToolDefinition>;
  /**
   * Where this bundle's tools execute (issue #7): "child" means every
   * execute() runs in a boundary child process (scrubbed env, cwd jail,
   * timeout, tree kill) — see boundary.ts. "in-process" is the pre-#7
   * behaviour: the tool runs inside this Node process with its privileges.
   */
  execution: ExecutionMode;
}

/** Where loaded tools run their execute(). */
export type ExecutionMode = "in-process" | "child";

export interface LoadBundleOptions {
  /** Module specifiers allowed past the blocklist (see safety.ts). */
  allowModules?: string[];
  /**
   * Where tool execute() runs. Default "in-process" for `loadBundle` itself
   * (a metadata listing should not pay for a spawn, and tests of the gate are
   * about the gate) — but EVERY agent-facing path passes "child":
   * createHarness defaults to it, so does the watcher and the CLI. See the
   * README "Execution boundary" section for why the default lives at the seam
   * rather than here.
   */
  execution?: ExecutionMode;
  /** Boundary knobs when execution is "child" (timeout, env allowlist, cwd). */
  boundary?: BoundaryOptions;
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

/**
 * Resolve a manifest tool ref against the bundle dir, enforcing containment
 * (dcd8c081): refs must be relative, must not contain ".." segments, and must
 * resolve inside the bundle dir — both lexically and after realpath (so a
 * symlinked tool file cannot escape the bundle).
 */
export async function resolveToolRef(bundleDir: string, ref: string): Promise<string> {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new Error(`manifest tool refs must be non-empty strings (got ${JSON.stringify(ref)})`);
  }
  if (path.isAbsolute(ref) || ref.startsWith("~")) {
    throw new Error(`manifest tool ref "${ref}" must be relative to the bundle dir`);
  }
  if (ref.split(/[\\/]+/).includes("..")) {
    throw new Error(`manifest tool ref "${ref}" must not traverse with ".."`);
  }
  const lexical = path.resolve(bundleDir, ref);
  if (!isWithin(bundleDir, lexical)) {
    throw new Error(`manifest tool ref "${ref}" resolves outside the bundle dir`);
  }
  // Follow symlinks: the real file must still live inside the real bundle dir.
  const realFile = await fs.realpath(lexical);
  if (!isWithin(bundleDir, realFile)) {
    throw new Error(
      `manifest tool ref "${ref}" resolves outside the bundle dir (symlink escape)`,
    );
  }
  return realFile;
}

/**
 * Read + load a bundle directory. THE gated load path (ccdbbb2b / 51b81dda):
 * every caller — createHarness, the watcher, the CLI — goes through here, and
 * here the safety gate runs on every tool file's on-disk source BEFORE it is
 * ever imported. Manifest shape and tool-ref containment are enforced too.
 * Throws on invalid manifests/tools/broken sources; never imports rejected code.
 */
export async function loadBundle(
  dir: string,
  scope: ScopeName | null = null,
  opts: LoadBundleOptions = {},
): Promise<LoadedBundle> {
  const realDir = await fs.realpath(dir); // throws if missing (deleted bundle)
  const manifestPath = path.join(realDir, "manifest.json");
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
  const execution: ExecutionMode = opts.execution ?? "in-process";

  // 1. Gate every ref on the on-disk source, BEFORE anything can run — the same
  //    gate in both modes. The gate filters what gets LOADED; the boundary
  //    constrains where what-is-loaded RUNS. Neither replaces the other.
  const gated: Array<{ ref: string; fileAbs: string }> = [];
  for (const ref of manifest.tools) {
    const fileAbs = await resolveToolRef(realDir, ref);
    const source = await fs.readFile(fileAbs, "utf8");
    const gateOpts: SafetyOptions = {
      allowModules: opts.allowModules,
      rootDir: realDir,
      baseDir: path.dirname(fileAbs),
    };
    const report = checkToolSource(source, gateOpts);
    if (!report.ok) {
      const detail = report.issues.map((i) => `[${i.kind}] ${i.message}`).join("; ");
      throw new Error(
        `bundle "${manifest.name}": tool ${ref} rejected by safety gate: ${detail}`,
      );
    }
    gated.push({ ref, fileAbs });
  }

  if (execution === "child") {
    // THE BOUNDARY (#7): the host never evaluates bundle code. One describe
    // spawn reports each tool's name/description/schema; every later execute()
    // spawns again. A bundle that hangs, crashes or reaches for the agent's
    // environment does it somewhere that can be killed and has nothing to steal.
    const describe = await runInChild(
      {
        mode: "describe",
        dir: realDir,
        refs: gated.map((g) => g.ref),
        allowModules: opts.allowModules,
      },
      { cwd: realDir, ...opts.boundary },
    );
    if (describe.status !== "ok" || !describe.response?.tools) {
      throw new Error(
        `bundle "${manifest.name}": failed to load tools in the boundary child: ${describeBoundedFailure(describe)}`,
      );
    }
    for (const desc of describe.response.tools) {
      const tool = boundedTool({
        bundleName: manifest.name,
        dir: realDir,
        ref: desc.ref,
        desc,
        allowModules: opts.allowModules,
        boundary: opts.boundary,
      });
      if (tools.has(tool.name)) {
        throw new Error(`bundle "${manifest.name}": duplicate tool name "${tool.name}"`);
      }
      tools.set(tool.name, tool);
    }
    return {
      id: `${manifest.name}@${manifest.version}`,
      dir: realDir,
      manifest,
      scope,
      tools,
      execution,
    };
  }

  for (const { ref, fileAbs } of gated) {
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
    dir: realDir,
    manifest,
    scope,
    tools,
    execution,
  };
}

/**
 * A tool whose execute() delegates to a boundary child. The host holds a
 * description and a spawn recipe, never the bundle's module object — which is
 * the whole point: the schema is data, the code stays out of this process.
 */
function boundedTool(args: {
  bundleName: string;
  dir: string;
  ref: string;
  desc: ChildToolDescription;
  allowModules?: string[];
  boundary?: BoundaryOptions;
}): ToolDefinition {
  const { bundleName, dir, ref, desc, allowModules, boundary } = args;
  return {
    name: desc.name,
    description: desc.description,
    schema: desc.schema as ToolSchema,
    async execute(params: Record<string, unknown>): Promise<string> {
      const run = await runInChild(
        {
          mode: "execute",
          dir,
          refs: [ref],
          tool: desc.name,
          params,
          allowModules,
        },
        { cwd: dir, ...boundary },
      );
      if (run.status !== "ok") {
        throw new Error(
          `bundle "${bundleName}" tool "${desc.name}" (${ref}) did not complete ` +
            `[${run.status}, ${run.durationMs}ms]: ${describeBoundedFailure(run)}`,
        );
      }
      return run.response?.result ?? "";
    },
  };
}
