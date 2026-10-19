/**
 * Managed policy: what an administrator sets for every user of a machine, and nothing
 * below it can widen. Precedence is managed > user (`$MNEMO_HOME/permissions.json`)
 * > project (a folder's `.agents/`):
 *
 *   rules       tested before the user's: a managed `deny` or `ask` is never answered by
 *               a user `allow` or an "always" grant
 *   modes       the modes Mnemo may run in (leave out `yolo` and `--yolo` is refused)
 *   models      `provider/id` globs: a request to any other model is refused before it is sent
 *   mcpServers  server names (globs) Mnemo may start, from any mcp.json
 *   hooks       hooks that run before the user's own (extensions/hooks.ts)
 *
 * The file lives where only an administrator can write it, and Mnemo reads nothing that
 * would move it (no variable, no flag): a policy the user could point elsewhere is not one.
 * A file that is there and cannot be read stops every edit and command, as permissions.json does.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { globMatch, type Rule } from "../extensions/policy.ts";
import type { Mode } from "../extensions/host.ts";

export interface Managed {
  file: string;
  rules: Rule[];
  modes?: Mode[];
  models?: string[];
  mcpServers?: string[];
  /** Hooks every user runs, before their own (extensions/hooks.ts checks the shape). */
  hooks?: unknown;
  /** Set when the file is there and could not be understood. */
  error?: string;
}

const MODES: readonly Mode[] = ["default", "accept-edits", "plan", "yolo"];

export function managedPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") return path.win32.join(env.ProgramData || "C:\\ProgramData", "Mnemo", "managed.json");
  if (platform === "darwin") return "/Library/Application Support/Mnemo/managed.json";
  return "/etc/mnemo/managed.json";
}

/** What a broken file means: read-only, until an administrator fixes it. */
function broken(file: string, why: string): Managed {
  const note = `the managed policy ${file} cannot be read (${why}), so Mnemo refuses to change anything until it is fixed`;
  return { file, error: why, rules: ["edit", "write", "create_skill", "update_skill", "bash", "powershell", "ipy_run", "mcp__*"].map((tool) => ({ tool, action: "deny", note })) };
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Undefined when there is no file: no managed policy. */
export function loadManaged(file: string = managedPath()): Managed | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return broken(file, error instanceof Error ? error.message : String(error));
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return broken(file, "expected an object");
  const o = raw as Record<string, unknown>;
  const rules = "rules" in o ? o.rules : [];
  const validRule = (r: unknown) => {
    const x = r as Rule;
    return !!x && typeof x.tool === "string" && ["allow", "ask", "deny"].includes(x.action) && (x.pattern === undefined || typeof x.pattern === "string");
  };
  if (!Array.isArray(rules) || !rules.every(validRule)) return broken(file, `"rules" must be a list of {tool, pattern?, action}`);
  for (const key of ["modes", "models", "mcpServers"] as const)
    if (o[key] !== undefined && !strings(o[key])) return broken(file, `"${key}" must be a list of strings`);
  const modes = o.modes as string[] | undefined;
  if (modes && (modes.length === 0 || !modes.every((m) => (MODES as string[]).includes(m)))) return broken(file, `"modes" must name some of ${MODES.join(", ")}`);
  return { file, rules: rules as Rule[], modes: modes as Mode[] | undefined, models: o.models as string[] | undefined, mcpServers: o.mcpServers as string[] | undefined, hooks: o.hooks };
}

/**
 * The mode the gate applies: the one asked for when the policy allows it, otherwise the
 * strictest allowed mode that is no looser than it (and `plan`, or the strictest allowed, failing that).
 */
export function allowedMode(mode: Mode, managed: Managed | undefined): Mode {
  const allowed = managed?.modes;
  if (!allowed || allowed.includes(mode)) return mode;
  const looseness: Mode[] = ["plan", "default", "accept-edits", "yolo"];
  const below = looseness.slice(0, looseness.indexOf(mode)).reverse().find((m) => allowed.includes(m));
  return below ?? looseness.find((m) => allowed.includes(m))!;
}

export const nameAllowed = (list: readonly string[] | undefined, name: string) => !list || list.some((p) => globMatch(p, name));

type Guarded = "stream" | "complete" | "streamSimple" | "completeSimple";
type Runtime = Record<Guarded, (model: { provider: string; id: string }, ...rest: unknown[]) => unknown>;

/**
 * Every request a model runtime sends passes here, the session's, compaction's, reflection's
 * and a sub-agent's alike, so a model the policy does not list is refused whichever path chose it.
 */
export function enforceModels<T extends object>(runtime: T, managed: Managed | undefined): T {
  const allowed = managed?.models;
  if (!allowed) return runtime;
  const r = runtime as unknown as Runtime;
  for (const method of ["stream", "complete", "streamSimple", "completeSimple"] as const) {
    const original = r[method].bind(runtime);
    r[method] = (model, ...rest) => {
      const name = `${model.provider}/${model.id}`;
      if (!nameAllowed(allowed, name)) throw new Error(`${name} is not allowed by the managed policy (${managed!.file}). Allowed: ${allowed.join(", ")}. Pick one with /model.`);
      return original(model, ...rest);
    };
  }
  return runtime;
}
