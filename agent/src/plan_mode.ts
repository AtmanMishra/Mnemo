/**
 * 4.4 Plan mode: a read-only phase where the agent can investigate and propose,
 * but cannot change anything.
 *
 * Implemented as a synthesized ruleset for the 4.3 permission engine rather
 * than a second gate, so there is exactly one place that decides whether a
 * tool call runs.
 *
 * bash_exec is NOT read-only (`ls` and `rm -rf` arrive through the same tool),
 * so it is denied here and the block reason points the model at read_file and
 * glob_list instead.
 */
import type { Permissions, Rule } from "./permissions.ts";

/** Tools that cannot change the workspace, the memory graph, or the machine. */
export const READ_ONLY_TOOLS: readonly string[] = [
  "read_file",
  "glob_list",
  "list_skills",
  "load_skill",
  "memory_search",
];

let planMode = false;

export function isPlanMode(): boolean {
  return planMode;
}

/** Toggle at runtime (a slash command or the cockpit); env sets the initial value. */
export function setPlanMode(on: boolean): void {
  planMode = on;
}

export function planModeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MNEMO_PLAN_MODE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** allow every read-only tool, deny everything else. */
export function planModeRules(): Rule[] {
  const allow: Rule[] = READ_ONLY_TOOLS.map((tool) => ({ tool, pattern: "*", action: "allow" }));
  return [...allow, { tool: "*", pattern: "*", action: "deny" }];
}

/**
 * Plan-mode rules take precedence over the user's own rules: an `allow` in
 * permissions.json must not punch a hole in a read-only phase.
 */
export function withPlanMode(perms: Permissions, on: boolean = isPlanMode()): Permissions {
  if (!on) return perms;
  return { version: 1, rules: [...planModeRules(), ...perms.rules], default: "deny" };
}

export const PLAN_MODE_REASON =
  "plan mode is on, so this session is read-only. Investigate with read_file, " +
  "glob_list, list_skills, load_skill and memory_search, then propose the plan " +
  "in your reply — do not try to apply it.";
