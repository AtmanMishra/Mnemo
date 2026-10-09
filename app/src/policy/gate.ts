/**
 * What a tool call is allowed to do.
 *
 * A pure decision, three answers, no prompting and no I/O: given a call, the
 * rules in force, and the mode, say `allow`, `ask` or `deny`. Everything that
 * makes it humane lives in these rules, and each one is a mistake that was made
 * once already:
 *
 *  1. **A deny rule outranks everything, including full privileges.** "Stop
 *     asking" is a statement about questions, not about permissions; a mode that
 *     silently overrode a denial would make the denial decorative.
 *  2. **Approvals generalise by subcommand, never by program.** `git status
 *     --short` becomes `git status*` — never `git*`, which would hand over
 *     `git push`, `git checkout` and `git clean -xdf` with the same sentence
 *     the user agreed to. Args never generalise: `/etc/passwd` is not a class.
 *  3. **A compound command never inherits a grant.** `ls; rm -rf /` matches the
 *     `ls*` the user approved, and must not use it. Anything with a shell
 *     metacharacter is its own question.
 *  4. **`ask` is the default.** There is no fallthrough that quietly allows.
 */
export type Decision = "allow" | "ask" | "deny";

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface Grants {
  /** Patterns approved for this project (this session's checkout). */
  project: readonly string[];
  /** Patterns approved for every project. */
  global: readonly string[];
  /** Patterns refused; these win over every mode and every grant. */
  deny: readonly string[];
}

export interface GateMode {
  /** Full privileges: everything unanswered is allowed, denials still hold. */
  yolo?: boolean;
}

export interface GateResult {
  decision: Decision;
  /** The pattern this call generalises to, when it has one. */
  pattern?: string;
  /** Why, in the words the interface will show. */
  reason: string;
  /**
   * Whether a general answer is offerable at all. False for a compound command:
   * "always" there would mean "always run anything that starts like this".
   */
  offerAlways: boolean;
}

/** Shell metacharacters that make a command a sequence rather than a command. */
export const COMPOUND = /[;&|><`$(){}\n]|\|\|/;

/** Programs whose first word after the name picks what they do: `git status`, `npm test`. */
const SUBCOMMAND_PROGRAMS = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "make"]);
/** Subcommands whose arguments can carry a command of their own: never a class. */
const EXEC_SUBCOMMANDS = new Set(["config", "alias", "exec", "run-script"]);
/** Programs an approval must never widen: they act on whatever operand follows. */
const OPERAND_PROGRAMS = new Set(["rm", "mv", "cp", "dd", "chmod", "chown", "ln", "ssh", "scp", "rsync", "curl", "wget", "sudo", "su", "sh", "bash", "zsh", "dash", "env", "xargs", "find", "eval", "exec", "nohup", "kill", "tar", "sed", "awk", "python", "python3", "node", "perl", "ruby"]);

/**
 * The pattern a call generalises to — by subcommand for commands, by subject
 * for file tools, and not at all when nothing safe can be said.
 */
export function generalise(call: ToolCall): string | undefined {
  if (call.toolName === "read_file" || call.toolName === "write_file" || call.toolName === "apply_edit") {
    // A path is not a class: approving one file says nothing about the next.
    return undefined;
  }
  const command = call.input.command;
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;

  const parts = trimmed.split(/\s+/);
  // Skip leading assignments: in `FOO=1 git status`, the program is `git`, and
  // the subcommand search must start *after* the program rather than finding it
  // again — which is how `FOO=1 git status` first generalised to `git git*`.
  let index = 0;
  while (index < parts.length && parts[index]!.includes("=")) index += 1;
  const program = parts[index];
  if (!program) return undefined;

  const rest = parts.slice(index + 1);
  const sub = rest.find((part) => !part.startsWith("-"));
  const bare = program.replace(/^.*\//, "");
  if (SUBCOMMAND_PROGRAMS.has(bare)) {
    // `git status*`; but not `git config*`, whose arguments can name a program to run.
    if (sub && EXEC_SUBCOMMANDS.has(sub)) return trimmed;
    return sub ? `${program} ${sub}*` : `${program}*`;
  }
  // Anything else generalises only when there is nothing to generalise over:
  // an operand ("rm dist") is an argument, and arguments are never a class.
  if (sub || OPERAND_PROGRAMS.has(bare)) return trimmed;
  return `${program}*`;
}

function matchesCommand(pattern: string, command: string): boolean {
  if (command.length === 0) return false;
  command = command.replace(/\s+/g, " ");
  // A pattern without `*` is the exact command. One ending in `*` is a prefix that
  // must end on a word, so `git status*` covers `git status --short` but not
  // `git stash` or `git statusx`.
  if (!pattern.endsWith("*")) return command === pattern.replace(/\s+/g, " ").trim();
  const stem = pattern.slice(0, -1).replace(/\s+/g, " ").trimEnd();
  return command === stem || command.startsWith(stem + " ");
}

/**
 * The commands inside a command line, split on every shell separator.
 *
 * Deny rules are tested against each of these, because the alternative is the
 * hole that matters: with the rule `rm*` in force, `ls; rm -rf /` would be read
 * as one command that does not start with `rm` — and the denial would have
 * stopped nothing at all.
 */
export function commandSegments(command: string): string[] {
  return command
    .split(/[;&|><`$(){}\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Decide one call. Pure: same inputs, same answer, no side effects. */
export function decide(call: ToolCall, grants: Grants, mode: GateMode = {}): GateResult {
  const pattern = generalise(call);
  const command = typeof call.input.command === "string" ? call.input.command.trim() : "";
  const compound = command.length > 0 && COMPOUND.test(command);

  // 1. A denial is a denial — tested against every command in the line, so a
  //    refusal cannot be evaded by wrapping the refused command in another one.
  const segments = commandSegments(command);
  for (const denied of grants.deny) {
    const hit = segments.find((segment) => matchesCommand(denied, segment)) ??
      (matchesCommand(denied, command) ? command : undefined);
    if (hit) {
      return {
        decision: "deny",
        pattern,
        reason: `refused by a rule: ${denied}${hit === command ? "" : ` (matched "${hit}")`}`,
        offerAlways: false,
      };
    }
  }

  // 2. A compound command is never covered by a grant.
  if (compound) {
    return {
      decision: "ask",
      pattern,
      reason: "this runs more than one command, so an approval for one of them does not cover it",
      offerAlways: false,
    };
  }

  // 3. Grants, most specific store first.
  for (const [scope, patterns] of [["this project", grants.project], ["every project", grants.global]] as const) {
    for (const granted of patterns) {
      if (matchesCommand(granted, command)) {
        return { decision: "allow", pattern, reason: `approved for ${scope}: ${granted}`, offerAlways: false };
      }
    }
  }

  // 4. Full privileges: everything that survived the rules above.
  if (mode.yolo) {
    return { decision: "allow", pattern, reason: "full privileges are on", offerAlways: false };
  }

  // 5. Otherwise it is a question.
  return {
    decision: "ask",
    pattern,
    reason: pattern ? `not approved yet: ${pattern}` : "not approved yet",
    // Nothing to generalise means nothing to offer: "always" for a path, or for
    // a command with no shape, would be a promise the gate cannot keep.
    offerAlways: pattern !== undefined,
  };
}
