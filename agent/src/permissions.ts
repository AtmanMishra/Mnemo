/**
 * 4.3 Permission rule engine: ~/.mnemo/permissions.json.
 *
 * Rules are ordered; the FIRST match wins. Each rule names a tool and a glob
 * over that tool's subject (the command for bash_exec, the path for the file
 * tools), and one of three actions:
 *   allow - run it, no prompt
 *   ask   - prompt (the existing approval-gate behaviour)
 *   deny  - block it, never prompt
 *
 * `deny` is the one action that must hold in a non-TTY run. The approval gate
 * deliberately fails OPEN without a TTY so piped/automated sessions keep
 * working; a deny rule that also failed open would be decoration, so denies
 * are enforced regardless of TTY.
 *
 * SUB-AGENT POLICY (audit b6afa93e, fix 12.1): children spawned by
 * spawn_subagent carry MNEMO_SUBAGENT_CHILD=1 and have no TTY and no operator
 * behind them. For those processes the gate treats "ask" on a mutating tool
 * (bash_exec / write_file / apply_edit / ipy_run) as DENY — failing open
 * there would let a model-authored child execute unapproved mutations while
 * the user trusts the parent's prompts. The escape hatches, in order:
 *   1. an explicit `allow` rule for the tool (pre-approval),
 *   2. a `deny` rule is honored as everywhere else,
 *   3. running the tool in the parent session where the operator can prompt.
 * A parent process without a TTY (piped/automated runs) still fails open —
 * the operator opted into automation for the whole run.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Action = "allow" | "ask" | "deny";

export interface Rule {
  /** Tool name, or "*" for every tool. */
  tool: string;
  /** Glob over the tool's subject. "*" matches anything. */
  pattern: string;
  action: Action;
}

export interface Permissions {
  version: 1;
  rules: Rule[];
  /** Applied when no rule matches. */
  default: Action;
  /**
   * YOLO: every `ask` becomes an allow, with no prompt and no dialog.
   *
   * It does NOT override a `deny` rule. A mode named "full privileges" that
   * also silently discarded the operator's explicit "never do this" would be
   * the one surprise this system must not spring: a deny is a decision the
   * user already made, not a prompt they were about to answer. The startup
   * notice says how many denies are still in force, so "yolo" is never
   * mistaken for "unrestricted".
   */
  /**
   * Optional on purpose: a file written before this existed, and every rules
   * literal in the tests, means "off" by saying nothing. A missing mode is not
   * a mode — and the safe reading of an absent flag is the one that asks.
   */
  yolo?: boolean;
}

export const DEFAULT_PERMISSIONS: Permissions = { version: 1, rules: [], default: "ask", yolo: false };

export function permissionsFile(home = os.homedir()): string {
  return path.join(home, ".mnemo", "permissions.json");
}

/**
 * The project-scoped file: `<project>/.mnemo/permissions.json`.
 *
 * Deliberately inside the project, so a consent the operator gave for this
 * work is (a) remembered for every later session in the same project and
 * (b) reviewable — and, if the project is a repository, shareable with the
 * people who work in it. That is the point of a project scope; it is also why
 * it is not the default and why the dialog says which file it writes.
 */
export function projectPermissionsFile(cwd: string): string {
  return path.join(cwd, ".mnemo", "permissions.json");
}

/** Read the rules file. A missing or unreadable file means "no rules". */
export function loadPermissions(home = os.homedir(), file = permissionsFile(home)): Permissions {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizePermissions(raw);
  } catch {
    return DEFAULT_PERMISSIONS;
  }
}

export function savePermissions(p: Permissions, home = os.homedir(), target = permissionsFile(home)): void {
  const file = target;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic: the agent watches this file, and a reader that opens it between
  // the truncate and the write sees an empty file — which, for a permissions
  // file, means "no rules". Written beside and renamed, that cannot happen.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalizePermissions(p), null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const ACTIONS: readonly string[] = ["allow", "ask", "deny"];

/** Drop malformed rules rather than throwing: a broken file must not brick the CLI. */
export function normalizePermissions(raw: any): Permissions {
  const rules: Rule[] = Array.isArray(raw?.rules)
    ? raw.rules
        .filter((r: any) => typeof r?.tool === "string" && typeof r?.pattern === "string"
          && ACTIONS.includes(r?.action))
        .map((r: any) => ({ tool: r.tool, pattern: r.pattern, action: r.action as Action }))
    : [];
  const fallback: Action = ACTIONS.includes(raw?.default) ? raw.default : "ask";
  return { version: 1, rules, default: fallback, yolo: raw?.yolo === true };
}

/**
 * Both scopes, project first: the nearer consent wins, and the global file is
 * what it falls back to. `yolo` is true if either file says so, or if the
 * environment does — a mode that turned itself off depending on which file you
 * looked at would be a bug waiting for a support thread.
 */
export function loadScopedPermissions(cwd: string, home = os.homedir()): Permissions {
  const project = loadPermissions(home, projectPermissionsFile(cwd));
  const global = loadPermissions(home);
  return {
    version: 1,
    rules: [...project.rules, ...global.rules],
    default: project.rules.length > 0 ? project.default : global.default,
    yolo: project.yolo || global.yolo || yoloFromEnv(),
  };
}

/** MNEMO_YOLO / SEA_YOLO: 1, true, yes, on (case-insensitive). */
export function yoloFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MNEMO_YOLO ?? env.SEA_YOLO ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * The string a rule's glob is matched against. Deliberately the argument that
 * decides whether a call is dangerous, not a summary of it.
 */
export function subjectOf(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "bash_exec": return String((input as any).command ?? "");
    case "write_file":
    case "apply_edit":
    case "read_file": return String((input as any).path ?? "");
    default: return "";
  }
}

/** Tiny glob: `*` matches any run of characters. Everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
  const rx = "^" + pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*") + "$";
  return new RegExp(rx, "s").test(value);
}

// --- 12.5 (audit 3c265f44): bash allow-rules match ONE command, not a line --

/**
 * Operators that turn one bash line into several commands (or move data
 * around): separators, pipes, redirection, substitution. An allow rule may
 * not speak for anything after these — `ls*` names `ls`, not `ls ; rm -rf /`.
 */
const SHELL_CONTROL = /(?:[;&|<>\n`]|\$\()/;

/** True when the command is a single simple command with no shell operators. */
export function isSimpleCommand(command: string): boolean {
  return !SHELL_CONTROL.test(command);
}

/** First matching rule wins; `default` applies when nothing matches. */
export function resolveAction(
  perms: Permissions,
  toolName: string,
  input: Record<string, unknown>,
): Action {
  const subject = subjectOf(toolName, input);
  for (const r of perms.rules) {
    if (r.tool !== "*" && r.tool !== toolName) continue;
    // 12.5: an allow rule never approves more than it names. A bash line
    // carrying shell control operators is MANY commands, so allow rules
    // skip it entirely (the next rule / the default applies — usually a
    // prompt). Deny rules are unaffected: they match the raw line, and a
    // deny that fails open would be theatre.
    if (r.action === "allow" && toolName === "bash_exec" && !isSimpleCommand(subject)) continue;
    if (globMatch(r.pattern, subject)) return r.action;
  }
  return perms.default;
}
