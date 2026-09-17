/**
 * create_harness: the model-facing self-extension tool.
 * Bridges to harness-engine's createHarness() so the agent can build its own
 * tool plugins at runtime. Bundles are written into the PROJECT skill location
 * (.agents/skills), where:
 *   - harness-bridge syncs a SKILL.md so discovery lists them
 *   - the safety gate rejects dangerous source before anything touches disk
 */
import { Type } from "typebox";
import * as path from "node:path";
import { textResult, type SeaTool } from "./types.ts";
import { ensureHarnessIndexed, sharedMem, type HarnessIndexInput } from "../../extensions/memory-layer.ts";

const toolSpec = Type.Object({
  name: Type.String({ description: "Tool identifier, [a-z0-9_-]." }),
  description: Type.Optional(Type.String({ description: "What this tool does." })),
  schema: Type.Optional(Type.String({
    description: 'JSON-schema object as JSON string. Default: {"type":"object","properties":{}}',
  })),
  source: Type.String({
    description:
      "JS function body of the tool. Receives `params`, must return a string. " +
      "Example: return `hello ${params.name}`. The safety gate (run on every load) rejects: " +
      "fs/child_process and net-class imports (http, https, net, tls, dns, os), any process access, " +
      "absolute imports, non-literal import()/require() specifiers (variables, joins), " +
      "and relative imports that leave the bundle or import blocked modules. " +
      "The gate is lexical and is NOT a sandbox: rejected source never loads, but accepted " +
      "source is code you are writing for a machine to run. It runs in a child process with a " +
      "scrubbed environment and a timeout (see the result note), still as the same user with the " +
      "same filesystem and network rights.",
  }),
});

const parameters = Type.Object({
  name: Type.String({ description: "Bundle name, [a-z0-9_-], e.g. k8s-debug." }),
  description: Type.String({ description: "What this bundle is for." }),
  tools: Type.Array(toolSpec, { description: "One or more tools the bundle provides.", minItems: 1 }),
});

export interface CreateHarnessDeps {
  /** Injectable for tests. Defaults to harness-engine's real implementation. */
  createHarness?: (opts: any) => Promise<any>;
  /**
   * Index the created bundle into memory (Harness node, Procedural area,
   * manifest facts). Injectable for tests; defaults to the shared memsrv
   * client so a harness the agent builds is recallable later.
   */
  indexHarness?: (bundle: HarnessIndexInput) => Promise<string>;
  root?: string;
  /**
   * Where the bundle's tools execute once created. Default "child": see the
   * tool description — this is code the model wrote, so it does not get to run
   * in the agent's process with the agent's environment. Injectable so a test
   * can assert the seam's default without spawning.
   */
  execution?: "child" | "in-process";
}

export function makeCreateHarnessTool(deps: CreateHarnessDeps = {}): SeaTool {
  return {
    name: "create_harness",
    label: "Create harness",
    description:
      "Create a new tool plugin (harness bundle) at runtime. The bundle's tools become " +
      "available to you and are persisted as a discoverable skill. Use for capabilities you " +
      "find yourself missing mid-task. " +
      "TRUST AND BOUNDARY: a harness bundle is third-party code — the source is model-authored, " +
      "so it is on you to mean what you write. Once created, its tools run in a separate CHILD " +
      "process: scrubbed environment (no API keys), working directory jailed to the bundle, a " +
      "wall-clock timeout, and capture of everything the bundle prints. That bounds the blast " +
      "radius and hides this process's secrets. It is NOT a sandbox: the child still runs as the " +
      "same user, so anything you could read, write or reach on the network, the bundle can too. " +
      "Do not treat the safety gate as containment — it filters what LOADS, it does not contain " +
      "what RUNS.",
    parameters,
    async execute(_id, params: any) {
      let createHarness = deps.createHarness;
      if (!createHarness) {
        // lazy dynamic import keeps startup cheap and tests hermetic
        const mod = await import("../../../harness-engine/src/create-harness.ts");
        const { ToolRegistry } = await import("../../../harness-engine/src/registry.ts");
        const registry = new (ToolRegistry as any)();
        const orig = mod.createHarness;
        createHarness = async (opts: any) => {
          opts.registry = registry;
          return orig(opts);
        };
      }
      try {
        const root = deps.root
          ?? path.join(process.cwd(), ".agents", "skills");
        const execution = deps.execution ?? "child";
        const res = await (createHarness as any)({
          root,
          scope: "session",
          // #7: the tools the model writes do not run in this process by
          // default. "in-process" is here to be asked for, and only for a
          // caller that has decided the bundle is trusted.
          execution,
          spec: {
            name: params.name,
            description: params.description,
            tools: (params.tools ?? []).map((t: any) => ({
              name: t.name,
              description: t.description,
              schema: t.schema ? JSON.parse(t.schema) : { type: "object", properties: {} },
              source: t.source,
            })),
          },
        });
        const pretty = (res.tools as string[]).map((t) =>
          t.replace(/^tools\//, "").replace(/\.mjs$/, ""));
        // index the bundle into memory: best-effort, never breaks the call.
        // Idempotent — re-creating a bundle this session or in a past session
        // (journal persists) reuses the existing node instead of duplicating.
        let memNote = "";
        try {
          const index = deps.indexHarness ?? (async (bundle: HarnessIndexInput) => {
            const r = await ensureHarnessIndexed(sharedMem, bundle);
            return r.ok
              ? `\nmemory: harness ${r.existed ? "already known as" : "indexed as"} node #${r.node}`
              : `\nmemory: index failed (${r.error})`;
          });
          memNote = await index({
            name: params.name,
            description: params.description,
            tools: pretty,
            dir: res.dir,
            bundleId: res.bundleId,
          });
        } catch {
          /* memory indexing must not fail create_harness */
        }
        return textResult(
          `harness created: ${res.bundleId}\ntools: ${pretty.join(", ")}\nlocation: ${res.dir}\n` +
          `tools are registered for this session; the bundle persists on disk and is ` +
          `discoverable via list_skills.\n` +
          (execution === "child"
            ? `execution: each tool runs in a CHILD process — scrubbed environment (no API keys), ` +
              `cwd jailed to the bundle dir, wall-clock timeout, output captured. Blast-radius ` +
              `control, not a sandbox: the child is still this user, with this user's filesystem ` +
              `and network reach.`
            : `execution: in-process (explicitly requested) — this bundle's tools run INSIDE the ` +
              `agent process with the agent's environment and privileges.`) + memNote,
          { bundleId: res.bundleId, tools: pretty, execution },
        );
      } catch (err: any) {
        return textResult(`create_harness failed: ${err?.message ?? err}`);
      }
    },
  };
}

export const createHarnessTool: SeaTool = makeCreateHarnessTool();
