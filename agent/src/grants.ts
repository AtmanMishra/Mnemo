/**
 * Grants: what the consent dialog *remembers*, and where.
 *
 * The dialog (extensions/approval-gate.ts) offers four answers with a memory
 * plus an escape hatch:
 *
 *   allow once                    nothing is written
 *   allow always, this project    a rule in <project>/.mnemo/permissions.json
 *   allow always, everywhere      a rule in ~/.mnemo/permissions.json
 *   don't allow                   nothing is written
 *   other                         the operator's own words, handed to the model
 *
 * Two decisions in this file are the whole point of it:
 *
 * 1. WHAT A "SIMILAR COMMAND" IS. Generalising `git status --short` to `git *`
 *    would approve `git push --force` — the user answered a question about
 *    status and would be taken to have answered one about pushing. So the
 *    pattern keeps the program *and* its subcommand (`git status*`) and
 *    generalises only the arguments, which is the part the user is actually
 *    not interested in repeating. A single-word command generalises to
 *    `word *`, not `word*`, so `ls *` cannot be read as `lsof`.
 *
 * 2. WHAT IS NOT OFFERED. A command carrying shell control operators is many
 *    commands (`ls; rm -rf /`), so "always" is not offered for it — the same
 *    principle as permissions.ts 12.5, where an allow rule may not speak for
 *    anything after `;` `|` `&` `>` `<` or a substitution. The dialog asks
 *    per invocation instead, and says why.
 *
 * Paths are never generalised: "this file" is a fact, "similar paths" is a
 * guess, and a guessed grant is one the user did not give. The *scope* is what
 * makes a file grant reusable — the same file in this project, or everywhere.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  globMatch,
  isSimpleCommand,
  loadPermissions,
  normalizePermissions,
  permissionsFile,
  projectPermissionsFile,
  savePermissions,
  type Action,
  type Permissions,
  type Rule,
} from "./permissions.ts";

export type GrantScope = "project" | "global";

/**
 * Programs whose *second* word is the real verb, so the second word is kept.
 * Anything not listed keeps only its first word plus its arguments: a program
 * nobody has heard of is a program whose subcommands we cannot guess, and
 * guessing wide is how `foo *` becomes a rubber stamp.
 */
const VERB_SECOND: ReadonlySet<string> = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl",
  "uv", "pip", "pipx", "poetry", "deno", "gh", "az", "aws", "gcloud", "helm",
  "terraform", "systemctl", "brew", "scoop", "winget", "apt", "apt-get", "dnf",
  "yum", "pacman", "node", "python", "python3", "pnpm", "dotnet", "gradle",
  "mvn", "make", "just", "task", "bazel",
]);

/**
 * The pattern a grant would store for this call, or null when "always" must
 * not be offered (see the file header). `tool` is the tool name; `subject` is
 * permissions.subjectOf(tool, input) — the command, or the path.
 */
export function similarPattern(tool: string, subject: string): string | null {
  const value = subject.trim();
  if (value === "") return null;

  if (tool !== "bash_exec") {
    // A path: exact, escaped for globMatch (where only `*` is special).
    return value.replace(/\*/g, "[*]");
  }

  if (!isSimpleCommand(value)) return null;

  const tokens = value.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return null;

  const program = tokens[0];
  const second = tokens[1];
  // The subcommand, when the program is one whose second word is a verb and
  // that word is a word rather than a flag.
  if (second !== undefined && VERB_SECOND.has(program) && !second.startsWith("-")) {
    return `${program} ${second}*`;
  }
  return `${program} *`;
}

/** Human wording for the dialog option, so the choice states what it stores. */
export function grantLabel(scope: GrantScope, pattern: string): string {
  return scope === "project"
    ? `Allow always in this project (${pattern})`
    : `Allow always, everywhere (${pattern})`;
}

export interface WriteGrantOptions {
  scope: GrantScope;
  tool: string;
  pattern: string;
  /** The project whose file a project-scoped grant belongs in. */
  cwd: string;
  home?: string;
}

/** The file a scope writes to. */
export function grantFile(scope: GrantScope, cwd: string, home = os.homedir()): string {
  return scope === "project" ? projectPermissionsFile(cwd) : permissionsFile(home);
}

/**
 * Add an allow rule for this tool+pattern and return the file it went in, or
 * null when the rule was already there.
 *
 * Placement: after every existing `deny` rule and before everything else, so
 * a grant can never shadow a deny the operator wrote deliberately. Deny is the
 * strongest thing in this system and a dialog answer must not outrank it.
 */
export function writeGrant(opts: WriteGrantOptions): string | null {
  const home = opts.home ?? os.homedir();
  const file = grantFile(opts.scope, opts.cwd, home);
  const existing = loadPermissions(home, file);
  const rule: Rule = { tool: opts.tool, pattern: opts.pattern, action: "allow" };

  if (existing.rules.some((r) => r.tool === rule.tool && r.pattern === rule.pattern && r.action === "allow")) {
    return null; // already granted: writing again would only grow the file
  }

  const lastDeny = existing.rules.reduce((acc, r, i) => (r.action === "deny" ? i : acc), -1);
  const rules = existing.rules.slice();
  rules.splice(lastDeny + 1, 0, rule);

  savePermissions({ ...existing, rules }, home, file);
  return file;
}

/** Read one file's rules without the global fallback (used by the watcher). */
export function readRulesFile(file: string): Rule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizePermissions(raw).rules;
  } catch {
    return [];
  }
}

/**
 * Watch the grant files and call back when one changes, so a session that did
 * not make the decision still learns it (the "all other sessions get notified"
 * half of the feature).
 *
 * Watching the *directory*, not the file: the file may not exist yet, and on
 * Windows a watcher on a path that is replaced by an atomic rename stops
 * reporting — so per-file watchers are the kind of thing that works on the
 * machine it was written on.
 *
 * A watcher is best-effort by construction. The caller re-reads the rules on
 * every callback, so a missed event costs a stale view until the next tool
 * call, never a wrong decision made from a cached one.
 */
export function watchGrants(
  files: string[],
  onChange: (changed: string) => void,
  debounceMs = 150,
): () => void {
  const dirs = Array.from(new Set(files.map((f) => path.dirname(f))));
  const wanted = new Set(files.map((f) => path.basename(f)));
  const watchers: fs.FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, (_event, name) => {
        const base = name ? path.basename(String(name)) : "";
        if (base && !wanted.has(base)) return;
        const file = files.find((f) => path.basename(f) === base) ?? files[0];
        // Coalesce: an atomic write is rename + rename, and a reader that acts
        // on the first event reads a file that is not there yet.
        const pending = timers.get(file);
        if (pending) clearTimeout(pending);
        timers.set(file, setTimeout(() => {
          timers.delete(file);
          onChange(file);
        }, debounceMs));
        timers.get(file)?.unref?.();
      });
      w.on("error", () => { /* best-effort: see the header */ });
      // A watcher that holds the event loop open is a watcher that stops the
      // agent from ever exiting: pi finishes its turn, the extension's handle
      // is still live, and the process sits there. unref() keeps the watch
      // working while letting the process end when the work does.
      w.unref?.();
      watchers.push(w);
    } catch {
      // An unwatchable directory is not a reason to refuse to run.
    }
  }

  return () => {
    for (const t of timers.values()) clearTimeout(t);
    for (const w of watchers) {
      try { w.close(); } catch { /* already gone */ }
    }
  };
}

/**
 * Merge rules learned mid-session into the live set: new allows only, and
 * never over a deny. Used by the watcher; kept here so the rule about what may
 * change under a running session is in one place.
 */
export function mergeGrantedRules(current: Permissions, incoming: Rule[]): Permissions {
  const denies = current.rules.filter((r) => r.action === "deny");
  const rules = current.rules.slice();
  let added = false;
  for (const r of incoming) {
    if (r.action !== "allow") continue;
    if (denies.some((d) => d.tool === r.tool && globMatch(d.pattern, r.pattern.replace(/\*$/, "")))) continue;
    if (rules.some((x) => x.tool === r.tool && x.pattern === r.pattern)) continue;
    rules.splice(denies.length, 0, r);
    added = true;
  }
  return added ? { ...current, rules } : current;
}

export type { Action, Permissions, Rule };
