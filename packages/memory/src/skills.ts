/**
 * Skills as files. A project skill lives in the repository's
 * `.agents/skills/<name>/SKILL.md` (pi discovers it there, and it travels with
 * the code to teammates and other agents); a personal one in the caller's
 * user skills directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type SkillScope = "project" | "user";

export function renderSkill(name: string, description: string, body: string): string {
  const desc = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body.trim()}\n`;
}

export function skillPath(scope: SkillScope, name: string, where: { projectRoot: string; userSkillsDir: string }): string {
  return scope === "project" ? path.join(where.projectRoot, ".agents", "skills", name, "SKILL.md") : path.join(where.userSkillsDir, name, "SKILL.md");
}

export function writeSkill(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
