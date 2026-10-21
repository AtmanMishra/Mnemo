/**
 * Agent profiles: saved sub-agent definitions, like Claude Code's agent files. One Markdown file
 * per profile, `<name>.md`, in `$MNEMO_HOME/agent/agents/` (yours) or a trusted project's
 * `.agents/agents/`. The frontmatter sets what `spawn_subagent` would otherwise be asked for
 * (model, thinking, access, tools, limits) and a description; the body is instructions the
 * sub-agent gets in its system prompt.
 *
 *   ---
 *   description: Reviews a diff for bugs and says what to fix
 *   model: anthropic/claude-haiku-5-5
 *   access: read-only
 *   maxTurns: 20
 *   ---
 *   Read the diff, then each changed function in full. Report bugs first, then risks.
 *
 * A profile asks, as a parent does: the user's sub-agent settings stay the ceiling. Yours win
 * over a project's of the same name, so a cloned repository cannot replace a profile you wrote.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SpawnAsk } from "../extensions/agents.ts";
import { agentDir } from "./paths.ts";
import { THINKING_CHOICES } from "./settings.ts";

export interface Profile extends SpawnAsk {
  name: string;
  description: string;
  access?: "read-only" | "full";
  /** The tools it may use (its access still applies); unset is every tool its access allows. */
  tools?: string[];
  /** Instructions for its system prompt. */
  body: string;
  file: string;
  source: "user" | "project";
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL = /^[\w.-]+\/[\w.:/@+-]+$/;
const TOOL = /^[\w-]{1,64}$/;
const MAX_FILE = 32_000;
const MAX_BODY = 8_000;
const MAX_PROFILES = 50;

export const profilesDir = (home: string) => path.join(agentDir(home), "agents");

/** One profile from its file, or why it cannot be used. */
export function parseProfile(file: string, text: string, source: Profile["source"]): Profile | string {
  const name = path.basename(file, ".md");
  if (!NAME.test(name)) return `${file}: the name must be lowercase letters, digits and dashes`;
  if (text.length > MAX_FILE) return `${file}: larger than ${MAX_FILE} characters`;
  let fm: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter: fm, body } = parseFrontmatter(text));
  } catch (e) {
    return `${file}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const p: Profile = { name, description: "", body: body.trim().slice(0, MAX_BODY), file, source };
  const bad = (what: string) => `${file}: ${what}`;
  if (typeof fm.description !== "string" || !fm.description.trim()) return bad("needs a description (when to use it)");
  p.description = fm.description.replace(/\s+/g, " ").trim().slice(0, 200);
  if (fm.model !== undefined) {
    if (typeof fm.model !== "string" || !MODEL.test(fm.model)) return bad("model is provider/model-id");
    p.model = fm.model;
  }
  if (fm.thinking !== undefined) {
    if (!THINKING_CHOICES.includes(fm.thinking as never) || fm.thinking === "inherit") return bad(`thinking is one of ${THINKING_CHOICES.filter((l) => l !== "inherit").join(", ")}`);
    p.thinking = fm.thinking as string;
  }
  if (fm.access !== undefined) {
    if (fm.access !== "read-only" && fm.access !== "full") return bad("access is read-only or full");
    p.access = fm.access;
  }
  if (fm.tools !== undefined) {
    const tools = typeof fm.tools === "string" ? fm.tools.split(",").map((t) => t.trim()).filter(Boolean) : fm.tools;
    if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === "string" && TOOL.test(t))) return bad("tools is a list of tool names");
    p.tools = [...new Set(tools as string[])];
  }
  for (const key of ["maxTurns", "budget", "maxTokens", "contextTokens"] as const) {
    const v = fm[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !(v > 0) || !Number.isFinite(v)) return bad(`${key} is a positive number`);
    p[key] = v;
  }
  return p;
}

function readDir(dir: string, source: Profile["source"], into: Map<string, Profile>, errors: string[]): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return;
  }
  for (const f of names) {
    if (into.size >= MAX_PROFILES) {
      errors.push(`${dir}: more than ${MAX_PROFILES} profiles; the rest are left out`);
      return;
    }
    const file = path.join(dir, f);
    let text: string;
    try {
      if (!fs.statSync(file).isFile()) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const p = parseProfile(file, text, source);
    if (typeof p === "string") errors.push(p);
    else if (!into.has(p.name)) into.set(p.name, p);
  }
}

/** Your profiles, then a trusted project's (yours win on a name both have). */
export function loadProfiles(home: string, cwd: string, projectTrusted: boolean): { profiles: Map<string, Profile>; errors: string[] } {
  const profiles = new Map<string, Profile>();
  const errors: string[] = [];
  readDir(profilesDir(home), "user", profiles, errors);
  if (projectTrusted) readDir(path.join(cwd, ".agents", "agents"), "project", profiles, errors);
  return { profiles, errors };
}

/** The tools a profiled sub-agent gets: its list, within what its access allows. Talking to the team stays. */
export function profileTools(p: Pick<Profile, "tools">, allowed: readonly string[] | undefined): string[] | undefined {
  if (!p.tools) return allowed ? [...allowed] : undefined;
  const team = ["list_agents", "message_agent", "task_update"];
  const wanted = [...new Set([...p.tools, ...team])];
  return allowed ? wanted.filter((t) => allowed.includes(t)) : wanted;
}
