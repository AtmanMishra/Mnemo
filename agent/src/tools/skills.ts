/**
 * Skill tools: discovery, on-demand loading, self-created skills, and the
 * self-improvement path.
 *
 * create_skill is the self-extension seam: the model can write a new skill
 * into ~/.pi/agent/skills/<name>/SKILL.md, which discoverSkills() picks up
 * (global scope) on the next scan. setSkillsHome() lets tests redirect the
 * global skill root to a temp dir.
 *
 * patch_skill / retire_skill are the self-IMPROVEMENT seam. They edit an
 * existing SKILL.md only under strict conditions (stated reason, memory
 * evidence, a unique anchor, valid frontmatter afterwards, an unchanged
 * expectedHash when one is given), keep a timestamped undo copy under
 * ~/.mnemo/skill-history so an edit is reversible without git, re-run
 * discovery to prove the file still loads (patch) or no longer loads
 * (retire), and record the change in the memory graph — best-effort: a dead
 * or missing memory sidecar never fails the edit.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { discoverSkills, type SkillInfo } from "../skills/discovery.ts";
import { findHarnessBundles, syncBundlesToSkills, skillLocations } from "../skills/harness-bridge.ts";
import { applyEdits, assertPatchedSkill, markRetired, normalizeEdits } from "../skills/skill-edit.ts";
import { backupSkillBody, fileStamp, sha256Hex, setMnemoHome } from "../skills/skill-history.ts";
import { recordSkillEvent, type SkillEvidence, type SkillEventOutcome } from "../skills/skill-memory.ts";
import { sharedMem, indexDiscoveredHarnesses, type MemClient } from "../../extensions/memory-layer.ts";
import { textResult, type SeaTool } from "./types.ts";

export { setMnemoHome };

let skillsHomeOverride: string | null = null;
let projectRootOverride: string | null = null;

/** Tests: redirect PROJECT skill locations (.pi/skills, .agents/skills walk). */
export function setProjectRoot(root: string | null): void {
  projectRootOverride = root;
}
function projectRoot(): string {
  return projectRootOverride ?? process.cwd();
}

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
    const locations = skillLocations(projectRoot());
    // harness bundles (created via harness-engine) become discoverable skills
    try { syncBundlesToSkills(locations); } catch { /* best-effort */ }
    // ...and each one is indexed into memory on discovery. Idempotent by
    // manifest identity (label + bundle path): a node already recorded by a
    // previous discovery pass (or by create_harness) is reused, never
    // duplicated. Best-effort — a dead memsrv must not fail listing.
    try {
      await indexDiscoveredHarnesses(sharedMem, findHarnessBundles(locations));
    } catch { /* memory indexing must never break list_skills */ }
    const skills = await discoverSkills({ cwd: projectRoot(), home: skillsHome() });
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
    const skills = await discoverSkills({ cwd: projectRoot(), home: skillsHome() });
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

// ---------------------------------------------------------------------------
// Self-improvement: patch_skill / retire_skill
// ---------------------------------------------------------------------------

const CLAUDE_RE = /(^|[\\/])\.claude([\\/]|$)/i;
const NODE_MODULES_RE = /(^|[\\/])node_modules([\\/]|$)/i;

/**
 * The only roots patch_skill/retire_skill may write to: the global Mnemo
 * skill root (~/.pi/agent/skills) and project .agents/skills under the
 * session cwd. Everything else is someone else's tree — .claude/** belongs
 * to another tool, a package directory to whatever shipped it.
 */
export function patchableRoots(): string[] {
  return [globalSkillDir(), path.join(projectRoot(), ".agents", "skills")];
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Throw unless `file` is a SKILL.md inside one of the patchable roots. */
export function assertPatchableSkillPath(file: string, tool = "patch_skill"): void {
  const resolved = path.resolve(file);
  if (CLAUDE_RE.test(resolved)) {
    throw new Error(`${tool}: refusing ${resolved}: .claude/** belongs to another tool and is never edited`);
  }
  const skillDir = path.dirname(resolved);
  if (NODE_MODULES_RE.test(resolved) || fs.existsSync(path.join(skillDir, "package.json"))) {
    throw new Error(`${tool}: refusing ${resolved}: a package directory belongs to whatever shipped it, not to the agent`);
  }
  const roots = patchableRoots();
  if (!roots.some((root) => isWithinRoot(root, resolved))) {
    throw new Error(
      `${tool}: refusing ${resolved}: outside the patchable roots (${roots.join(", ")}). ` +
        `Only skills this agent owns are editable here; use write_file with explicit user intent for anything else`,
    );
  }
}

/** Evidence entries: numbers (and "#12"/"12" strings) are node ids; the rest are signatures. */
function normalizeEvidence(raw: unknown, tool: string): SkillEvidence {
  const list: unknown[] = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const nodes: number[] = [];
  const signatures: string[] = [];
  for (const item of list) {
    if (typeof item === "number" && Number.isInteger(item)) {
      nodes.push(item);
      continue;
    }
    if (typeof item === "string") {
      const s = item.trim();
      if (!s) continue;
      if (/^#?\d+$/.test(s)) {
        nodes.push(Number(s.replace(/^#/, "")));
        continue;
      }
      signatures.push(s);
      continue;
    }
    throw new Error(`${tool}: evidence entries must be memory node ids (numbers) or failure signatures (strings)`);
  }
  if (nodes.length === 0 && signatures.length === 0) {
    throw new Error(
      `${tool}: evidence is required — pass at least one memory node id or the explicit failure this edit answers ` +
        `(for example [12, "npm test: EPERM symlink"]), so the change is learning rather than scribbling`,
    );
  }
  return { nodes, signatures };
}

/** The discovered skill by name, or a refusal naming what IS available. */
async function requireDiscoveredSkill(name: string, tool: string): Promise<SkillInfo> {
  const skills = await discoverSkills({ cwd: projectRoot(), home: skillsHome() });
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    const known = skills.map((s) => s.name).join(", ") || "(none)";
    throw new Error(`${tool}: no skill named "${name}". Available: ${known}`);
  }
  return skill;
}

async function readSkillFile(file: string, tool: string): Promise<string> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (err: any) {
    throw new Error(`${tool}: cannot read ${file}: ${err?.message ?? err}`);
  }
}

/** expectedHash is optional; when given, a mismatch means the file changed. */
function verifyExpectedHash(expected: unknown, content: string, file: string, tool: string): void {
  if (expected === undefined || expected === null) return;
  const want = String(expected).trim().toLowerCase().replace(/^sha256:/, "");
  if (!want) return; // an empty string counts as "not given"
  const have = sha256Hex(content);
  if (want !== have) {
    throw new Error(
      `${tool}: expectedHash does not match ${file} — the file changed since you read it ` +
        `(expected ${want}, current ${have}). Read it again with load_skill, redo the edit against the new text, ` +
        `and pass the new hash`,
    );
  }
}

/** Put the file back exactly as it was; used when a post-write check fails. */
async function restoreQuietly(file: string, body: string): Promise<void> {
  try {
    await fsp.writeFile(file, body, "utf8");
  } catch {
    /* the undo copy under ~/.mnemo/skill-history still has it */
  }
}

export interface SkillEditDeps {
  /** Memory client for best-effort recording. Injectable; defaults to sharedMem. */
  mem?: Pick<MemClient, "request">;
}

const editParams = Type.Object(
  {
    find: Type.Optional(
      Type.String({ description: "Exact text to replace; must occur exactly once in the file. Use with replace." }),
    ),
    replace: Type.Optional(Type.String({ description: "Replacement for find (empty string deletes the anchor)." })),
    section: Type.Optional(
      Type.String({ description: "Name of a '## heading' whose body is replaced, up to the next ## heading. Use with body." }),
    ),
    body: Type.Optional(Type.String({ description: "New text for the section body." })),
  },
  { description: "One edit: {find, replace} to replace a unique anchor, or {section, body} to replace a section body." },
);

const evidenceParam = Type.Array(Type.Union([Type.Number(), Type.String()]), {
  minItems: 1,
  description:
    "Why the edit is warranted: one or more memory node ids (numbers) and/or explicit failure signatures (strings). " +
    "Required — a change without evidence is scribbling, not learning.",
});

const patchParams = Type.Object({
  name: Type.String({ description: "Skill to patch, as shown by list_skills." }),
  edits: Type.Array(editParams, { minItems: 1, description: "One or more edits, applied in order." }),
  reason: Type.String({ description: "Why this patch is right. Required; recorded in memory with the evidence." }),
  evidence: evidenceParam,
  expectedHash: Type.Optional(
    Type.String({
      description:
        "sha256 of the SKILL.md you read (optional but recommended). If it no longer matches, the patch is refused " +
        "and the file is left untouched.",
    }),
  ),
});

export interface PatchSkillDetails {
  path: string;
  scope: "project" | "global";
  edits: number;
  timestamp: string;
  hashBefore: string;
  hashAfter: string;
  history: string;
  memory: SkillEventOutcome;
}

export function makePatchSkillTool(deps: SkillEditDeps = {}): SeaTool {
  return {
    name: "patch_skill",
    label: "Patch skill",
    description:
      "Improve an existing skill in place after a session taught you something durable about doing the task: " +
      "apply {find, replace} or {section, body} edits to its SKILL.md. Strict by design — it needs a reason and " +
      "memory evidence (a node id or the failure it answers), refuses a stale expectedHash, an anchor that is " +
      "missing or not unique, an edit that breaks the frontmatter, a no-op, and any path outside the skills this " +
      "agent owns. Keeps a timestamped undo copy under ~/.mnemo/skill-history and records the change in memory.",
    parameters: patchParams,
    async execute(_id, params: any) {
      const tool = "patch_skill";
      const name = String(params?.name ?? "").trim();
      if (!name) throw new Error(`${tool}: name is required`);
      const reason = String(params?.reason ?? "").trim();
      if (!reason) throw new Error(`${tool}: reason is required — say why this patch is right`);
      const evidence = normalizeEvidence(params?.evidence, tool);
      const edits = normalizeEdits(params?.edits, tool);
      const skill = await requireDiscoveredSkill(name, tool);
      assertPatchableSkillPath(skill.path, tool);
      const before = await readSkillFile(skill.path, tool);
      verifyExpectedHash(params?.expectedHash, before, skill.path, tool);
      const after = applyEdits(before, edits, skill.path, tool);
      assertPatchedSkill(after, name, skill.path, tool);
      if (after === before) {
        throw new Error(
          `${tool}: the edits leave ${skill.path} byte-identical — a no-op patch is a mistake, not a success; nothing was written`,
        );
      }
      const stamp = fileStamp();
      const history = await backupSkillBody({ name, body: before, now: new Date(stamp.iso) });
      await fsp.writeFile(skill.path, after, "utf8");
      // Roundtrip: the improved skill must still be discovered under the same
      // name. If it is not, the write is undone and the caller sees why.
      const found = (await discoverSkills({ cwd: projectRoot(), home: skillsHome() })).find((s) => s.name === name);
      if (!found) {
        await restoreQuietly(skill.path, before);
        throw new Error(`${tool}: wrote ${skill.path} but discovery no longer picks up "${name}" — the write was undone, the file is unchanged`);
      }
      const memory = await recordSkillEvent(deps.mem ?? sharedMem, {
        action: "patch",
        name,
        path: skill.path,
        reason,
        evidence,
        timestamp: stamp.iso,
      });
      const details: PatchSkillDetails = {
        path: skill.path,
        scope: skill.scope,
        edits: edits.length,
        timestamp: stamp.iso,
        hashBefore: sha256Hex(before),
        hashAfter: sha256Hex(after),
        history,
        memory,
      };
      return textResult(
        [
          `Patched skill "${name}" (${edits.length} edit${edits.length === 1 ? "" : "s"}) at ${skill.path}`,
          `undo: ${history}`,
          memory.note,
        ].join("\n"),
        details,
      );
    },
  };
}

const retireParams = Type.Object({
  name: Type.String({ description: "Skill to retire, as shown by list_skills." }),
  reason: Type.String({ description: "Why this skill is superseded. Required; recorded in memory with the evidence." }),
  evidence: evidenceParam,
  expectedHash: Type.Optional(
    Type.String({
      description: "sha256 of the SKILL.md you read (optional). If it no longer matches, the retirement is refused.",
    }),
  ),
});

export interface RetireSkillDetails {
  path: string;
  scope: "project" | "global";
  timestamp: string;
  reason: string;
  history: string;
  discovered: false;
  memory: SkillEventOutcome;
}

export function makeRetireSkillTool(deps: SkillEditDeps = {}): SeaTool {
  return {
    name: "retire_skill",
    label: "Retire skill",
    description:
      "Retire (never delete) a skill that is superseded: its SKILL.md gains `retired: \"<reason>\"` in the " +
      "frontmatter, so discovery stops offering it while the file and its instructions stay on disk — removing " +
      "that line brings the skill back. Needs the same reason + memory evidence as patch_skill, keeps a " +
      "timestamped undo copy under ~/.mnemo/skill-history, and records the retirement in memory.",
    parameters: retireParams,
    async execute(_id, params: any) {
      const tool = "retire_skill";
      const name = String(params?.name ?? "").trim();
      if (!name) throw new Error(`${tool}: name is required`);
      const reason = String(params?.reason ?? "").trim();
      if (!reason) throw new Error(`${tool}: reason is required — say why this skill is superseded`);
      const evidence = normalizeEvidence(params?.evidence, tool);
      const skill = await requireDiscoveredSkill(name, tool);
      assertPatchableSkillPath(skill.path, tool);
      const before = await readSkillFile(skill.path, tool);
      verifyExpectedHash(params?.expectedHash, before, skill.path, tool);
      const after = markRetired(before, reason, skill.path, tool);
      if (after === before) {
        throw new Error(`${tool}: ${skill.path} already carries this retirement; nothing was written`);
      }
      const stamp = fileStamp();
      const history = await backupSkillBody({ name, body: before, now: new Date(stamp.iso) });
      await fsp.writeFile(skill.path, after, "utf8");
      // Roundtrip the other way: retirement must take the skill OUT of
      // discovery. A same-named skill elsewhere means the retirement did not
      // take effect, so the write is undone rather than half-applied.
      const still = (await discoverSkills({ cwd: projectRoot(), home: skillsHome() })).find((s) => s.name === name);
      if (still) {
        await restoreQuietly(skill.path, before);
        throw new Error(
          `${tool}: wrote ${skill.path} but discovery still finds "${name}" at ${still.path} — ` +
            `another skill with that name lives there; the write was undone`,
        );
      }
      const memory = await recordSkillEvent(deps.mem ?? sharedMem, {
        action: "retire",
        name,
        path: skill.path,
        reason,
        evidence,
        timestamp: stamp.iso,
      });
      const details: RetireSkillDetails = {
        path: skill.path,
        scope: skill.scope,
        timestamp: stamp.iso,
        reason,
        history,
        discovered: false,
        memory,
      };
      return textResult(
        [
          `Retired skill "${name}" at ${skill.path} — frontmatter now carries retired: "${reason.replace(/\s+/g, " ").trim()}"`,
          `undo: ${history}`,
          "The file is kept and no longer discovered; remove the retired line to bring the skill back.",
          memory.note,
        ].join("\n"),
        details,
      );
    },
  };
}

export const patchSkillTool: SeaTool = makePatchSkillTool();
export const retireSkillTool: SeaTool = makeRetireSkillTool();
