/**
 * A skills marketplace the way Claude Code lays one out: a folder (usually a git repository)
 * with `.claude-plugin/marketplace.json` listing plugins, each a folder of skills
 * (`<plugin>/skills/<skill>/SKILL.md`, or the paths its `skills` array names). Only the skills
 * of a plugin are used here; its commands, agents, hooks and servers are not.
 *
 * Everything in a marketplace is a name someone else chose, so every name and path is checked
 * before it is used as a path: a plugin cannot point outside the marketplace's folder.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_JSON = 1024 * 1024;

export interface Plugin {
  name: string;
  description?: string;
  /** Absolute folder of the plugin, inside the marketplace. */
  dir: string;
  skills: Skill[];
  /** Why it cannot be used, e.g. its source is another repository. */
  skipped?: string;
}

export interface Skill {
  name: string;
  description?: string;
  /** Absolute folder holding SKILL.md. */
  dir: string;
}

/** `dir`/`rel` as an absolute path, if it stays inside `dir` (also after links are followed). */
export function inside(dir: string, rel: string): string | undefined {
  const full = path.resolve(dir, rel);
  const within = (root: string, p: string) => p === root || p.startsWith(root + path.sep);
  if (!within(path.resolve(dir), full)) return undefined;
  try {
    return within(fs.realpathSync(dir), fs.realpathSync(full)) ? full : undefined;
  } catch {
    return undefined;
  }
}

/** `name:` and `description:` from a SKILL.md's frontmatter, as much as is needed to list it. */
export function frontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const field = (k: string) => {
    const hit = m && new RegExp(`^${k}:\\s*(.*)$`, "m").exec(m[1]!);
    return hit ? hit[1]!.trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: field("name"), description: field("description") };
}

function skillAt(dir: string, fallback: string): Skill | undefined {
  try {
    const file = path.join(dir, "SKILL.md");
    if (!fs.lstatSync(file).isFile()) return undefined;
    const fm = frontmatter(fs.readFileSync(file, "utf8").slice(0, 8192));
    const name = NAME.test(path.basename(dir)) ? path.basename(dir) : fallback;
    return NAME.test(name) ? { name, description: fm.description, dir } : undefined;
  } catch {
    return undefined;
  }
}

function skillsOf(plugin: string, dir: string, listed: unknown): Skill[] {
  const out: Skill[] = [];
  if (Array.isArray(listed)) {
    for (const rel of listed) {
      const d = typeof rel === "string" ? inside(dir, rel) : undefined;
      const s = d && skillAt(d, plugin);
      if (s) out.push(s);
    }
    return out;
  }
  const root = inside(dir, "skills");
  if (root && fs.existsSync(root))
    for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const d = e.isDirectory() ? inside(root, e.name) : undefined;
      const s = d && skillAt(d, e.name);
      if (s) out.push(s);
    }
  if (!out.length) {
    const s = skillAt(dir, plugin);
    if (s) out.push({ ...s, name: plugin });
  }
  return out;
}

/** The marketplace's name and plugins, or why it is not one. */
export function readMarketplace(root: string): { name: string; description?: string; plugins: Plugin[] } {
  const file = [".claude-plugin/marketplace.json", "marketplace.json"].map((r) => inside(root, r)).find((f) => f && fs.existsSync(f));
  if (!file) throw new Error("no .claude-plugin/marketplace.json in it: it is not a marketplace");
  if (fs.statSync(file).size > MAX_JSON) throw new Error("its marketplace.json is larger than 1 MB");
  let raw: { name?: unknown; description?: unknown; plugins?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("its marketplace.json is not valid JSON");
  }
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) throw new Error('its marketplace.json needs a "name" of letters, digits, dot, dash and underscore');
  if (!Array.isArray(raw.plugins)) throw new Error('its marketplace.json needs a "plugins" list');
  const plugins: Plugin[] = [];
  for (const p of raw.plugins as Record<string, unknown>[]) {
    if (typeof p?.name !== "string" || !NAME.test(p.name)) continue;
    const description = typeof p.description === "string" ? p.description : undefined;
    const source = p.source ?? "./";
    if (typeof source !== "string" || !/^\.\.?(\/|$)/.test(source)) {
      plugins.push({ name: p.name, description, dir: root, skills: [], skipped: "its source is another repository or address, which Mnemo does not fetch" });
      continue;
    }
    const dir = inside(root, source);
    if (!dir || !fs.existsSync(dir)) {
      plugins.push({ name: p.name, description, dir: root, skills: [], skipped: "its folder is not in the marketplace" });
      continue;
    }
    const skills = skillsOf(p.name, dir, p.skills);
    plugins.push({ name: p.name, description, dir, skills, skipped: skills.length ? undefined : "it has no skills" });
  }
  return { name: raw.name, description: typeof raw.description === "string" ? raw.description : undefined, plugins };
}
