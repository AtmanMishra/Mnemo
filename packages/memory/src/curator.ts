/**
 * Skills that nobody uses any more.
 *
 * Skills accumulate: every procedure worth saving once stays in the list the
 * model sees, whether or not anything still needs it (Hermes Agent's own
 * issue #7816 is this complaint). The curator reads when each skill was last
 * used — the "last used" fact a run records when it reads a skill, else the
 * file's modification time — and sorts them into active, stale and
 * archivable. Archiving (with `apply`) moves a personal skill out of the
 * skills directory into a sibling `skills-archive/`, where it is no longer
 * loaded but nothing is lost. A project skill lives in the repository and
 * belongs to the team: it is reported, never moved.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryService } from "./service.ts";
import { factValue } from "./service.ts";

export interface SkillStatus {
  name: string;
  file: string;
  scope: "project" | "user";
  /** ISO date of the last use, or of the file's last change when never seen used. */
  lastUsed: string;
  ageDays: number;
  state: "active" | "stale" | "archive";
  /** Set when `apply` moved it. */
  archivedTo?: string;
}

export interface CurateOptions {
  memory: MemoryService;
  /** The repository whose `.agents/skills` are reported. */
  projectRoot?: string;
  userSkillsDir: string;
  now?: number;
  /** Unused this long: stale (default 30 days). */
  staleDays?: number;
  /** Unused this long: archived, when personal (default 90 days). */
  archiveDays?: number;
  apply?: boolean;
}

function skillFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => path.join(dir, d.name, "SKILL.md"))
    .filter((f) => fs.existsSync(f));
}

export async function curateSkills(o: CurateOptions): Promise<SkillStatus[]> {
  const now = o.now ?? Date.now();
  const day = 86_400_000;
  const stale = o.staleDays ?? 30;
  const archive = o.archiveDays ?? 90;
  const found = [
    ...(o.projectRoot ? skillFiles(path.join(o.projectRoot, ".agents", "skills")).map((file) => ({ file, scope: "project" as const })) : []),
    ...skillFiles(o.userSkillsDir).map((file) => ({ file, scope: "user" as const })),
  ];
  const out: SkillStatus[] = [];
  for (const { file, scope } of found) {
    const name = path.basename(path.dirname(file));
    const node = await o.memory.findLabel(`skill ${name}`);
    const used = node === undefined ? undefined : factValue(await o.memory.state(node), "last used");
    const last = used ? Date.parse(used) : fs.statSync(file).mtimeMs;
    const ageDays = Math.floor((now - last) / day);
    const state = ageDays >= archive ? "archive" : ageDays >= stale ? "stale" : "active";
    const status: SkillStatus = { name, file, scope, lastUsed: new Date(last).toISOString().slice(0, 10), ageDays, state };
    if (o.apply && state === "archive" && scope === "user") {
      const to = path.join(path.dirname(o.userSkillsDir), "skills-archive", name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(path.dirname(file), to);
      status.archivedTo = to;
      if (node !== undefined) await o.memory.log(node, "archived", `unused for ${ageDays} days`);
    }
    out.push(status);
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}
