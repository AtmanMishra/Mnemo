#!/usr/bin/env node
/**
 * harness-engine CLI.
 *
 *   harness-engine list [--skills <dir>] [--global-skills <dir>]
 *   harness-engine create <spec.json> [--skills <dir>] [--scope global|project|session]
 *   harness-engine watch  [--skills <dir>] [--global-skills <dir>] [--debounce <ms>]
 *
 * `create` reads a JSON file shaped like HarnessSpec:
 * { "name": "...", "description": "...", "tools": [{ "name": "...", "schema": {...}, "source": "..." }] }
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "./registry.ts";
import { loadBundle } from "./bundle.ts";
import { SkillsWatcher } from "./watcher.ts";
import { createHarness, type HarnessSpec } from "./create-harness.ts";
import { getLoaderTool } from "./loader-tool.ts";

function parseArgs(argv: string[]): Record<string, string | boolean> & { _list?: string[] } {
  const out: Record<string, string | boolean> & { _list?: string[] } = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else {
      positional.push(a);
      out._ = (out._ ? `${out._} ${a}` : a) as string;
    }
  }
  out._list = positional;
  return out;
}

function expand(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

async function main(): Promise<number> {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const skills = expand(String(args.skills ?? "./skills"));
  const registry = new ToolRegistry();
  // #7: the CLI is a caller like any other — the boundary is the default, and
  // `--in-process` is the explicit downgrade.
  const execution: "child" | "in-process" = args["in-process"] ? "in-process" : "child";
  const boundary = { timeoutMs: args.timeout ? Number(args.timeout) : undefined };

  if (cmd === "list") {
    // Register whatever is on disk right now (project scope), then list.
    try {
      for (const entry of await fs.readdir(skills, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          registry.register(
            await loadBundle(path.join(skills, entry.name), "project", { execution, boundary }),
            "project",
          );
        } catch (err) {
          console.error(`! ${entry.name}: ${(err as Error).message}`);
        }
      }
    } catch { /* no skills dir yet */ }
    const loader = getLoaderTool(registry); // shown as available-but-lazy tool
    console.log(`registry (${registry.list().length} visible tools; loader tool "${loader.name}" always present):`);
    for (const t of registry.list()) {
      console.log(`  - ${t.name} [${t.scope}] ${t.bundleId}${t.description ? ` — ${t.description}` : ""}`);
    }
    console.log(`execution: ${execution}${execution === "child" ? " (scrubbed env, cwd jail, timeout; --in-process to run here)" : " (NOT sandboxed, NOT isolated: bundle code runs in this process)"}`);
    return 0;
  }

  if (cmd === "run") {
    // One bundle tool, through the boundary, with its verdict printed verbatim.
    const [bundleDir = "", toolName = ""] = args._list ?? [];
    if (!bundleDir || !toolName) {
      throw new Error("usage: harness-engine run <bundleDir> <tool> [--params '<json>'] [--timeout <ms>]");
    }
    const bundle = await loadBundle(bundleDir, "project", { execution, boundary });
    const found = bundle.tools.get(toolName);
    if (!found) {
      console.error(`no tool "${toolName}" in ${bundle.id} (has: ${[...bundle.tools.keys()].join(", ")})`);
      return 1;
    }
    const params = args.params ? JSON.parse(String(args.params)) : {};
    try {
      console.log(await found.execute(params));
      return 0;
    } catch (err) {
      // Never swallow what the bundle said: the error text IS the report.
      console.error(`run failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (cmd === "create") {
    const specFile = String(args._ ?? "");
    if (!specFile) throw new Error("usage: harness-engine create <spec.json> [--skills <dir>]");
    const spec = JSON.parse(await fs.readFile(specFile, "utf8")) as HarnessSpec;
    const result = await createHarness({
      registry,
      root: skills,
      spec,
      scope: (String(args.scope ?? "session") || "session") as never,
      execution,
      boundary,
    });
    console.log(`created ${result.bundleId} at ${result.dir}`);
    console.log(`tools: ${result.tools.join(", ")}`);
    return 0;
  }

  if (cmd === "watch") {
    const dirs: Array<{ path: string; scope: "global" | "project" }> = [];
    const globalSkills = args["global-skills"]
      ? expand(String(args["global-skills"]))
      : path.join(os.homedir(), ".agent", "skills");
    dirs.push({ path: globalSkills, scope: "global" });
    dirs.push({ path: skills, scope: "project" });
    const watcher = new SkillsWatcher(registry, dirs, {
      debounceMs: Number(args.debounce ?? 500),
      onError: (err, where) => console.error(`[invalidate] ${where}: ${err.message}`),
    });
    watcher.start();
    console.log(`watching:`);
    for (const d of dirs) console.log(`  ${d.scope.padEnd(7)} ${d.path}`);
    console.log("ctrl-c to stop");
    setInterval(() => {}, 1 << 30); // keep alive
    return 0;
  }

  console.log(
    [
      "harness-engine — dynamic harness/plugin engine",
      "",
      "commands:",
      "  list                          show visible tools",
      "  create <spec.json>            write + register a bundle (harness_create)",
      "  run <bundleDir> <tool>        run one bundle tool through the boundary",
      "  watch                         watch ./skills and ~/.agent/skills",
      "",
      "options: --skills <dir> --global-skills <dir> --scope <s> --debounce <ms>",
      "         --params '<json>' --timeout <ms> --in-process",
      "",
      "Bundle code runs in a CHILD PROCESS by default: scrubbed environment, cwd",
      "jailed to the bundle dir, wall-clock timeout, tree kill. That is blast-radius",
      "control, NOT a sandbox — the child is still you, with your filesystem and",
      "network rights. --in-process runs bundle code in THIS process instead.",
    ].join("\n"),
  );
  return cmd === "help" ? 0 : 1;
}

main()
  .then((code) => process.exitCode = code)
  .catch((err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
