/**
 * AREA 9.1 — manifest discovery + scope resolution.
 *
 * A hook lives in one of three scope roots:
 *   project  <project>/.mnemo/hooks          (committed with the repo, overrides)
 *   user     <home>/.mnemo/hooks             (that user, every project)
 *   global   <home>/.config/mnemo/hooks      (machine/org-wide policy)
 *
 * Only JSON files in the root directory (not nested) are scanned for
 * manifests. A file is a hook manifest only if it parses as one — state
 * files like hook-state.json have no `trigger` and are ignored naturally.
 *
 * Effective resolution: for each id, the highest-precedence scope that
 * defines it wins ("project overrides"); the result is ordered scoped-then-id
 * (all project hooks first, sorted by id, then user, then global). A disabled
 * key (bare id or scope:id) removes the hook entirely.
 *
 * All roots are injected — nothing here reads the real machine unless the
 * caller says so (HANDOFF §6.3).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Hook, type HookManifest, type Scope, parseManifest, isTrigger,
} from "./types.ts";

export const HOOKS_DIR = "hooks";
/** Filenames the scanner refuses even if they parse (reserved markers). */
const SKIP_FILES = new Set(["state.json", "disabled.json", "hook-state.json"]);

export function projectHookRoot(project: string): string {
  return path.join(project, ".mnemo", HOOKS_DIR);
}

export function userHookRoot(home: string): string {
  return path.join(home, ".mnemo", HOOKS_DIR);
}

export function globalHookRoot(home: string): string {
  return path.join(home, ".config", "mnemo", HOOKS_DIR);
}

export interface ScanOptions {
  /** Project root for the project scope; omit to skip that scope. */
  project?: string;
  /** User home; drives user + global roots. */
  home: string;
  /** Override the global root (tests, custom installs). */
  globals?: string;
}

export function scopeRoots(opts: ScanOptions): Array<{ scope: Scope; root: string }> {
  const out: Array<{ scope: Scope; root: string }> = [];
  if (opts.project) out.push({ scope: "project", root: projectHookRoot(opts.project) });
  out.push({ scope: "user", root: userHookRoot(opts.home) });
  out.push({ scope: "global", root: opts.globals ?? globalHookRoot(opts.home) });
  return out;
}

/** Read one JSON file as a hook manifest; null on any failure. */
export function readManifest(file: string): HookManifest | null {
  let body: string;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const hook = parseManifest(raw, file);
  return hook;
}

/** Alias: named for the callers that want the disk wrapper explicitly. */
export function parseHookFile(file: string): HookManifest | null {
  return readManifest(file);
}

/** All manifests in one root directory, sorted by id (stable execution order). */
export function scanHookDir(root: string): HookManifest[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return []; // missing root is not an error
  }
  const hooks: HookManifest[] = [];
  for (const name of entries) {
    if (SKIP_FILES.has(name)) continue;
    if (!name.endsWith(".json")) continue;
    if (name.startsWith(".")) continue;
    const h = readManifest(path.join(root, name));
    if (h) hooks.push(h);
  }
  hooks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hooks;
}

/**
 * The effective, execution-ordered hook list across all scopes.
 *
 * For each id only ONE copy runs: the highest-precedence scope that defines
 * it AND is not disabled. Ordering is scoped-then-id (all project hooks
 * first, id-sorted, then user, then global). A hook is skipped when its
 * manifest says `enabled: false` or its id (or scope:id) is in the disabled
 * set — and a disabled project copy is not allowed to shadow a live
 * lower-scope copy of the same id.
 */
export function loadHooks(opts: ScanOptions, disabled: ReadonlySet<string> = new Set()): Hook[] {
  // every manifest per scope (map id -> hook); dedupe happens at output time
  const perScope = new Map<Scope, Map<string, HookManifest>>();
  for (const { scope, root } of scopeRoots(opts)) {
    let m = perScope.get(scope);
    if (!m) perScope.set(scope, (m = new Map()));
    for (const h of scanHookDir(root)) {
      if (h.enabled === false) continue;
      m.set(h.id, h);
    }
  }
  const out: Hook[] = [];
  for (const scope of ["project", "user", "global"] as Scope[]) {
    const m = perScope.get(scope);
    if (!m) continue;
    const row: Hook[] = [];
    for (const [id, hook] of m) {
      if (out.some((h) => h.id === id)) continue; // higher scope already owns this id
      if (disabled.has(id) || disabled.has(`${scope}:${id}`)) continue;
      row.push({ ...hook, scope, file: hook.file });
    }
    row.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push(...row);
  }
  return out;
}

/**
 * What scope currently owns id, without consulting the disabled set — used
 * by /hook disable to decide which copy to target.
 */
export function ownerScope(opts: ScanOptions, id: string): Scope | null {
  for (const scope of ["project", "user", "global"] as Scope[]) {
    const root = scopeRoots(opts).find((r) => r.scope === scope)?.root ?? "";
    if (scanHookDir(root).some((h) => h.id === id)) return scope;
  }
  return null;
}

/** All manifests per scope, unmerged and unordered — what `/hook list` shows. */
export function listPerScope(opts: ScanOptions): Array<{ scope: Scope; root: string; hooks: HookManifest[] }> {
  return scopeRoots(opts).map(({ scope, root }) => ({ scope, root, hooks: scanHookDir(root) }));
}

/** Validate a manifest-shaped object without touching the disk. */
export function validateManifest(obj: Record<string, unknown>): string | null {
  if (typeof obj.id !== "string" || obj.id.trim() === "") return "id must be a non-empty string";
  if (!isTrigger(obj.trigger)) return `trigger must be one of: ${["PreToolUse", "PostToolUse", "UserPromptSubmit", "TurnEnd", "SessionStart", "SessionShutdown", "Notification"].join(", ")}`;
  if (typeof obj.command !== "string" || obj.command.trim() === "") return "command must be a non-empty string";
  return null;
}