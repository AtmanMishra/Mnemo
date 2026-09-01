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
}

export const DEFAULT_PERMISSIONS: Permissions = { version: 1, rules: [], default: "ask" };

export function permissionsFile(home = os.homedir()): string {
  return path.join(home, ".mnemo", "permissions.json");
}

/** Read the rules file. A missing or unreadable file means "no rules". */
export function loadPermissions(home = os.homedir()): Permissions {
  try {
    const raw = JSON.parse(fs.readFileSync(permissionsFile(home), "utf8"));
    return normalize(raw);
  } catch {
    return DEFAULT_PERMISSIONS;
  }
}

export function savePermissions(p: Permissions, home = os.homedir()): void {
  const file = permissionsFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalize(p), null, 2) + "\n", { mode: 0o600 });
}

const ACTIONS: readonly string[] = ["allow", "ask", "deny"];

/** Drop malformed rules rather than throwing: a broken file must not brick the CLI. */
function normalize(raw: any): Permissions {
  const rules: Rule[] = Array.isArray(raw?.rules)
    ? raw.rules
        .filter((r: any) => typeof r?.tool === "string" && typeof r?.pattern === "string"
          && ACTIONS.includes(r?.action))
        .map((r: any) => ({ tool: r.tool, pattern: r.pattern, action: r.action as Action }))
    : [];
  const fallback: Action = ACTIONS.includes(raw?.default) ? raw.default : "ask";
  return { version: 1, rules, default: fallback };
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
