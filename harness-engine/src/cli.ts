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

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._ = (out._ ? `${out._} ${a}` : a) as string;
  }
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

  if (cmd === "list") {
    // Register whatever is on disk right now (project scope), then list.
    try {
      for (const entry of await fs.readdir(skills, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          registry.register(await loadBundle(path.join(skills, entry.name), "project"), "project");
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
    return 0;
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
      "  watch                         watch ./skills and ~/.agent/skills",
      "",
      "options: --skills <dir> --global-skills <dir> --scope <s> --debounce <ms>",
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
