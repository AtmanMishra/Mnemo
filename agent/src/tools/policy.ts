/**
 * P6 (#14) — the tool exposure policy: `~/.mnemo/tools.json`.
 *
 * `permissions.json` decides whether a call is *allowed* once the model asks
 * for it. This decides whether the model is offered the tool at all — a
 * different question, asked in a different place, and the one that costs a
 * turn when it is wrong: `web_search` without a key is offered every session
 * and explains itself every session.
 *
 * Format — one file per scope, both optional:
 *
 *     { "disabled": ["web_search", "create_harness"] }
 *
 *     user     ~/.mnemo/tools.json        ($MNEMO_HOME/tools.json if set)
 *     project  <cwd>/.mnemo/tools.json
 *
 * The union of the two applies. Three decisions in that sentence:
 *
 * 1. **A disabled list, not an enabled one.** A tool added in a later version
 *    is then on by default for everyone who already has a file. An enabled
 *    list would silently take a new capability away from every user who never
 *    heard of it, and the failure would look like a missing feature rather
 *    than like a policy.
 * 2. **No wildcard, no patterns.** `"*"` is only useful with an enable list to
 *    add things back, and two lists of opposite polarity is the second
 *    registry this issue exists to prevent. Names are exact.
 * 3. **A project file can only restrict.** It is a union, never an override,
 *    so it needs no trust decision the way `.pi/settings.json` does (#17): a
 *    file that could *re-enable* `web_search` after the operator turned it off
 *    would.
 *
 * Failure is a missing policy, never a broken build: an absent file is not a
 * policy, an unparseable one is skipped and reported (`broken`), and entries
 * that are not strings are dropped. Nothing here can widen the surface — only
 * `disabled` is read — so a malformed file fails closed in the direction that
 * matters (everything on, exactly as before this file existed).
 *
 * Timing, and why there is no notice to wait for: the effective policy is read
 * when `src/tools/index.ts` is first imported, which for a session is extension
 * load — process start. Editing tools.json therefore lands on the **next run**,
 * not mid-session. Invariant 6 makes the tool list part of the cached prompt
 * prefix, and a filter that applied itself mid-turn would be the bug that
 * invariant names; reading once is that rule enforced by construction rather
 * than by a notice someone might miss. In the interface, `/new` is not a new
 * process — the spawn is.
 *
 * The cost, named rather than hidden: the read happens at import, and
 * invariant 5 ("config is a parameter, never a lookup") would rather see it
 * injected from the wiring site. The wiring site is an inline extension factory
 * with no parameters to add one to, and the alternative — an `activeTools()`
 * nothing calls — is the dead code this repo files issues about. So the lookup
 * is here, and a test that asserts the full inventory must state its own
 * `MNEMO_HOME`, the same discipline the tests around `permissions.json`
 * already follow. With no policy file present, every test on a clean machine
 * and in CI sees exactly the inventory it saw before.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { mnemoHome } from "../home.ts";
import type { SeaTool } from "./types.ts";

export const TOOLS_FILE = "tools.json";

/** The user scope: `~/.mnemo/tools.json`. */
export function toolsFile(home = mnemoHome()): string {
  return path.join(home, TOOLS_FILE);
}

/** The project scope: `<cwd>/.mnemo/tools.json`, the same shape as permissions. */
export function projectToolsFile(cwd: string): string {
  return path.join(cwd, ".mnemo", TOOLS_FILE);
}

export interface PolicyFileRead {
  /** False when the file is not there — "no policy", never "no tools". */
  present: boolean;
  disabled: string[];
  /** Why a present file could not be used. The rest of the decision stands. */
  broken?: string;
}

export interface PolicyIo {
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
}

/** One file's `disabled` list. Never throws. */
export function readToolsFile(file: string, io: PolicyIo = {}): PolicyFileRead {
  const exists = io.exists ?? fs.existsSync;
  const read = io.read ?? ((f: string) => fs.readFileSync(f, "utf8"));
  if (!exists(file)) return { present: false, disabled: [] };

  let body: string;
  try {
    body = read(file);
  } catch (err: any) {
    return { present: true, disabled: [], broken: `cannot read: ${err?.message ?? err}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err: any) {
    return { present: true, disabled: [], broken: `not JSON: ${err?.message ?? err}` };
  }
  const list = (raw as { disabled?: unknown } | null)?.disabled;
  if (list === undefined) return { present: true, disabled: [] };
  if (!Array.isArray(list)) {
    return { present: true, disabled: [], broken: "`disabled` must be an array of tool names" };
  }
  // An entry that is not a non-empty string names nothing. Dropping it is not
  // leniency: the one thing a policy must never do is resolve to a tool nobody
  // wrote down, and `{ "disabled": [true] }` must not be read as a name.
  const disabled = list
    .filter((n): n is string => typeof n === "string" && n.trim() !== "")
    .map((n) => n.trim());
  return { present: true, disabled };
}

export interface ToolPolicy {
  /** Tool names switched off, from every scope that had a say. */
  disabled: ReadonlySet<string>;
  /** The files that had a say, project first — for a readback to name. */
  files: string[];
  /** Files that are there and could not be used. */
  broken: Array<{ file: string; reason: string }>;
}

export interface PolicyOptions extends PolicyIo {
  /** Defaults to `$MNEMO_HOME` / `~/.mnemo`. */
  home?: string;
  /** Defaults to `process.cwd()` — the project the agent was told to work in. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The policy in force: the union of every scope that has something to say.
 *
 * Project first in `files` so a readback reads the way the resolution ran, and
 * deduplicated by absolute path because a user whose project *is* their home
 * must not have one file counted twice.
 */
export function loadScopedToolPolicy(over: PolicyOptions = {}): ToolPolicy {
  const env = over.env ?? process.env;
  const home = over.home ?? mnemoHome(env);
  const cwd = over.cwd ?? process.cwd();

  const disabled = new Set<string>();
  const files: string[] = [];
  const broken: Array<{ file: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const file of [projectToolsFile(cwd), toolsFile(home)]) {
    const key = path.resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);
    const read = readToolsFile(file, over);
    if (!read.present) continue;
    files.push(file);
    if (read.broken) {
      broken.push({ file, reason: read.broken });
      continue;
    }
    for (const name of read.disabled) disabled.add(name);
  }
  return { disabled, files, broken };
}

/** The tools a session may use, given the policy. Order is preserved. */
export function applyToolPolicy(tools: readonly SeaTool[], policy: ToolPolicy): SeaTool[] {
  if (policy.disabled.size === 0) return [...tools];
  return tools.filter((t) => !policy.disabled.has(t.name));
}
