/**
 * Skill tools: discovery, on-demand loading, and self-created skills.
 *
 * create_skill is the self-extension seam: the model can write a new skill
 * into ~/.pi/agent/skills/<name>/SKILL.md, which discoverSkills() picks up
 * (global scope) on the next scan. setSkillsHome() lets tests redirect the
 * global skill root to a temp dir.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { discoverSkills } from "../skills/discovery.ts";
import { syncBundlesToSkills, skillLocations } from "../skills/harness-bridge.ts";
import { textResult, type SeaTool } from "./types.ts";

let skillsHomeOverride: string | null = null;

/** Point the "global" skill root at a custom directory (tests). */
export function setSkillsHome(home: string | null): void {
  skillsHomeOverride = home;
}

function skillsHome(): string {
  return skillsHomeOverride ?? os.homedir();
}

/** Sanitize a skill name to [a-z0-9-]. */
export function sanitizeSkillName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) {
    throw new Error(`create_skill: name "${raw}" contains no [a-z0-9] characters`);
  }
  return cleaned;
}

export function globalSkillDir(): string {
  return path.join(skillsHome(), ".pi", "agent", "skills");
}

const listParams = Type.Object({});

export const listSkillsTool: SeaTool = {
  name: "list_skills",
  label: "List skills",
  description:
    "List discovered skills (name, scope, description). Use load_skill to read the full instructions of one.",
  parameters: listParams,
  async execute() {
    // harness bundles (created via harness-engine) become discoverable skills
    try { syncBundlesToSkills(skillLocations(process.cwd())); } catch { /* best-effort */ }
    const skills = await discoverSkills({ cwd: process.cwd(), home: skillsHome() });
    if (skills.length === 0) return textResult("(no skills found)", { skills: [] });
    const width = Math.max(...skills.map((s) => s.name.length));
    const lines = skills.map(
      (s) => `${s.name.padEnd(width)}  ${s.scope.padEnd(7)}  ${s.description}`,
    );
    return textResult(lines.join("\n"), { skills });
  },
};

const loadParams = Type.Object({
  name: Type.String({ description: "Skill name, as shown by list_skills." }),
});

export const loadSkillTool: SeaTool = {
  name: "load_skill",
  label: "Load skill",
  description:
    "Load a skill's full SKILL.md body and follow its instructions for the current task.",
  parameters: loadParams,
  async execute(_id, params) {
    const skills = await discoverSkills({ cwd: process.cwd(), home: skillsHome() });
    const skill = skills.find((s) => s.name === params.name);
    if (!skill) {
      const known = skills.map((s) => s.name).join(", ") || "(none)";
      throw new Error(`load_skill: no skill named "${params.name}". Available: ${known}`);
    }
    let raw: string;
    try {
      raw = await fsp.readFile(skill.path, "utf8");
    } catch (err: any) {
      throw new Error(`load_skill: cannot read ${skill.path}: ${err?.message ?? err}`);
    }
    return textResult(raw, { path: skill.path, scope: skill.scope });
  },
};

const createParams = Type.Object({
  name: Type.String({ description: "Skill name; sanitized to [a-z0-9-]." }),
  description: Type.String({ description: "One-line description shown by list_skills." }),
  instructions: Type.String({ description: "Full SKILL.md body: steps, rules, examples the model should follow when using this skill." }),
});

export const createSkillTool: SeaTool = {
  name: "create_skill",
  label: "Create skill",
  description:
    `Create a persistent skill at ${globalSkillDir()}/<name>/SKILL.md so it is discoverable in every future session.`,
  parameters: createParams,
  async execute(_id, params) {
    const name = sanitizeSkillName(params.name);
    if (!params.description?.trim()) throw new Error("create_skill: description is required");
    if (!params.instructions?.trim()) throw new Error("create_skill: instructions are required");
    const dir = path.join(globalSkillDir(), name);
    const file = path.join(dir, "SKILL.md");
    await fsp.mkdir(dir, { recursive: true });
    const body = [
      "---",
      `name: ${name}`,
      `description: ${params.description.trim().replace(/\s*\n\s*/g, " ")}`,
      "---",
      "",
      params.instructions.trimEnd(),
      "",
    ].join("\n");
    await fsp.writeFile(file, body, "utf8");
    // Roundtrip check: must be immediately discoverable.
    const found = (await discoverSkills({ home: skillsHome() })).find((s) => s.name === name);
    if (!found) throw new Error(`create_skill: wrote ${file} but discovery did not pick it up`);
    return textResult(`Created skill "${name}" at ${file}`, { path: file, scope: found.scope });
  },
};
