/**
 * Harness <-> Skills bridge (the self-extension triangle).
 *
 * harness-engine's createHarness() writes bundles: <dir>/manifest.json +
 * tool .mjs files. This bridge makes those bundles FIRST-CLASS SKILLS:
 * for every bundle manifest found under the skill locations, it generates a
 * SKILL.md describing how to use the bundle's tools, so that:
 *   - discovery.ts lists the harness as a skill (agent can load instructions)
 *   - memory layer gets a Harness node logging its existence (via memsrv)
 *
 * Idempotent: existing SKILL.md with matching content is left untouched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface HarnessBundleInfo {
  name: string;
  version: string;
  description: string;
  tools: string[];
  dir: string;
}

export function skillLocations(root?: string): string[] {
  const home = os.homedir();
  const project = root ?? process.cwd();
  return [
    path.join(home, ".pi", "agent", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(project, ".pi", "skills"),
    path.join(project, ".agents", "skills"),
  ];
}

/** Find harness-engine bundles (manifest.json with name+tools) under dirs. Read-only: metadata only, never imports tool code (the gated load lives in harness-engine's loadBundle). */
export function findHarnessBundles(dirs: string[]): HarnessBundleInfo[] {
  const found: HarnessBundleInfo[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(dir, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        // strict manifest shape: non-empty string tool refs only
        if (
          typeof m.name === "string" &&
          Array.isArray(m.tools) &&
          m.tools.length > 0 &&
          m.tools.every((t: unknown) => typeof t === "string" && t.length > 0)
        ) {
          found.push({
            name: m.name,
            version: m.version ?? "0.0.0",
            description: m.description ?? "",
            tools: m.tools,
            dir: path.join(dir, entry.name),
          });
        }
      } catch { /* malformed manifest: skip */ }
    }
  }
  return found;
}

export function renderSkillMd(b: HarnessBundleInfo): string {
  const lines = [
    "---",
    `name: ${b.name}`,
    `description: Harness plugin v${b.version}. Tools: ${b.tools.join(", ")}. ${b.description}`.trim(),
    "---",
    "",
    `# ${b.name} (harness)`,
    "",
    "This skill wraps a dynamically created harness bundle.",
    "Its executable tools live next to this file and are registered by the",
    "harness-engine registry at runtime. Available tools:",
    "",
    ...b.tools.map((t) => `- ${t}`),
    "",
  ];
  return lines.join("\n");
}

/** Ensure every bundle has a SKILL.md; returns paths written (new/updated). */
export function syncBundlesToSkills(dirs: string[]): string[] {
  const written: string[] = [];
  for (const b of findHarnessBundles(dirs)) {
    const skillPath = path.join(b.dir, "SKILL.md");
    const content = renderSkillMd(b);
    try {
      if (fs.existsSync(skillPath) && fs.readFileSync(skillPath, "utf8") === content) continue;
      fs.writeFileSync(skillPath, content);
      written.push(skillPath);
    } catch { /* read-only location: skip */ }
  }
  return written;
}
