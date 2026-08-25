/**
 * Skill discovery for sea-agent.
 *
 * A skill is a directory containing a SKILL.md file with YAML frontmatter:
 *
 *   ---
 *   name: my-skill
 *   description: What this skill does
 *   ---
 *   Free-form instructions the model follows after loading the skill.
 *
 * Locations (pi's standard skill locations):
 *   global : ~/.pi/agent/skills/  and  ~/.agents/skills/
 *   project: .pi/skills/ and .agents/skills/ in cwd + ancestors up to (and
 *            including) the git root
 *
 * Precedence: project overrides global on a name clash; within project,
 * nearer ancestors win over farther ones. The first sighting of a name wins
 * during the scan, so scan order is nearest-project-dir ... farthest,
 * then global dirs.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  scope: "project" | "global";
}

export interface DiscoveryOptions {
  cwd?: string;
  home?: string;
}

export interface ParsedSkill {
  meta: Record<string, string>;
  body: string;
}

/**
 * Minimal YAML frontmatter parser for flat `key: value` pairs only.
 * Returns null for anything malformed (missing --- fences, non-flat lines),
 * so callers can skip bad SKILL.md files gracefully.
 */
export function parseFrontmatter(raw: string): ParsedSkill | null {
  const lines = raw.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return null;
  const meta: Record<string, string> = {};
  let closed = false;
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      closed = true;
      i++;
      break;
    }
    if (line.trim() === "") continue;
    // Flat scalar only: `key: value`. Nested YAML (indentation) or list syntax
    // means this parser does not understand the file -> treat as malformed.
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/);
    if (!m || /^\s/.test(line)) return null;
    meta[m[1]] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  if (!closed) return null; // unterminated frontmatter fence
  return { meta, body: lines.slice(i).join("\n") };
}

/** Directories that may contain skill subdirectories, in precedence order. */
export function skillLocations(opts: DiscoveryOptions = {}): Array<{ dir: string; scope: "project" | "global" }> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const out: Array<{ dir: string; scope: "project" | "global" }> = [];
  for (const level of projectAncestors(cwd)) {
    out.push({ dir: path.join(level, ".pi", "skills"), scope: "project" });
    out.push({ dir: path.join(level, ".agents", "skills"), scope: "project" });
  }
  out.push({ dir: path.join(home, ".pi", "agent", "skills"), scope: "global" });
  out.push({ dir: path.join(home, ".agents", "skills"), scope: "global" });
  return out;
}

/**
 * Walk from startDir up to (and including) the git root — the first ancestor
 * containing a `.git` entry. If no git root exists, walk to the filesystem root.
 */
export function projectAncestors(startDir: string): string[] {
  const levels: string[] = [];
  let current = path.resolve(startDir);
  while (true) {
    levels.push(current);
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root reached, no .git anywhere
    current = parent;
  }
  return levels; // nearest first
}

/** Scan every location and resolve name clashes (first sighting wins). */
export async function discoverSkills(opts: DiscoveryOptions = {}): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>();
  for (const { dir, scope } of skillLocations(opts)) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue; // missing location is normal
    }
    for (const entry of entries) {
      const skillMd = path.join(dir, entry, "SKILL.md");
      let raw: string;
      try {
        raw = await fsp.readFile(skillMd, "utf8");
      } catch {
        continue; // directory without SKILL.md -> not a skill
      }
      const parsed = parseFrontmatter(raw);
      const name = parsed?.meta.name?.trim();
      const description = parsed?.meta.description?.trim();
      if (!parsed || !name || !description) continue; // malformed -> skip gracefully
      if (byName.has(name)) continue; // earlier (higher-precedence) location wins
      byName.set(name, { name, description, path: skillMd, scope });
    }
  }
  return [...byName.values()];
}
