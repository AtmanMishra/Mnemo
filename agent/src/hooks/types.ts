/**
 * AREA 9 — hook contract (research/all-in-one-agent-design.md Part A).
 *
 * A hook = one small rule file (JSON) + one runnable command (any language).
 * The manifest declares the pi event it fires on, an optional matcher, and
 * what the engine may do with the result (block / audit / modify). Scope
 * resolution and precedence are handled by scanner.ts; execution semantics
 * by executor.ts.
 *
 * Core modules in src/hooks/ never import pi types or read real machine state
 * on their own — every call chain takes injected roots (HANDOFF §6.3), so
 * tests run against temp dirs and a fake pi.
 */

/** Triggers map 1:1 onto pi events (see hooks-inline.ts for the wiring). */
export type Trigger =
  | "PreToolUse"        // pi tool_call      — can block, can rewrite args
  | "PostToolUse"       // pi tool_result    — can modify the result
  | "UserPromptSubmit"  // pi input          — can block / transform the prompt
  | "TurnEnd"           // pi turn_end       — observation
  | "SessionStart"      // pi session_start  — observation
  | "SessionShutdown"   // pi session_shutdown — observation
  | "Notification";     // Part B schedules  — not wired in v1

export const TRIGGERS: readonly Trigger[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "TurnEnd",
  "SessionStart",
  "SessionShutdown",
  "Notification",
];

export function isTrigger(v: unknown): v is Trigger {
  return typeof v === "string" && (TRIGGERS as readonly string[]).includes(v);
}

/** Three scopes, project overrides user overrides global; see scanner.ts. */
export type Scope = "project" | "user" | "global";

export const SCOPES: readonly Scope[] = ["project", "user", "global"];

/** Lower number = higher precedence (runs first; an id here hides lower scopes). */
export const SCOPE_ORDER: Record<Scope, number> = { project: 0, user: 1, global: 2 };

export interface HookMatcher {
  /** Regex matched against the tool name; absent = match any tool. */
  tool?: string;
  /**
   * Glob matched against the tool call's path-ish argument (path/file/glob/
   * dst/dir). A hook with a path matcher does NOT run when the tool call
   * carries no such argument: it is a path-scoped rule, not a tool rule.
   */
  path?: string;
}

export interface HookOn {
  /** PreToolUse: exit 2 vetoes the call (always honoured whatever this says). */
  block?: boolean;
  /** Audit the invocation to ~/.mnemo/logs. Default true. */
  audit?: boolean;
  /**
   * PreToolUse: exit-0 JSON may rewrite args.
   * PostToolUse: exit-0 JSON may modify the result.
   */
  modify?: boolean;
}

/**
 * A hook as the loader hands the engine: the manifest plus the resolved
 * scope. `scope`/`file` are never written back to the manifest file.
 */
export type Hook = HookManifest & { scope: Scope; file?: string };


/**
 * One hook manifest as it lives on disk. `scope`/`file` are filled in by the
 * loader and are never written back to the manifest.
 */
export interface HookManifest {
  id: string;
  trigger: Trigger;
  matcher?: HookMatcher;
  /** Command to run; relative paths resolve against the manifest's directory. */
  command: string;
  /** Kill the command after this many seconds; a timeout allows + logs. */
  timeout?: number;
  on?: HookOn;
  /** "disabled" marker inside the manifest itself; honoured by the loader. */
  enabled?: boolean;
  description?: string;
  /** Declared intent. Not enforced in v1 (hooks get the parent's network). */
  network?: boolean;
  // --- loader-filled (never serialized) ---
  scope?: Scope;
  file?: string;
}

export function isHookOn(v: unknown): v is HookOn {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null) return false;
  for (const k of ["block", "audit", "modify"] as const) {
    if (k in v && typeof (v as Record<string, unknown>)[k] !== "boolean") return false;
  }
  return true;
}

/**
 * Shape-check one parsed JSON object as a manifest. Anything malformed is
 * rejected outright — a broken hook file must never half-run.
 */
export function parseManifest(raw: unknown, file?: string): HookManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.trim() === "") return null;
  if (!isTrigger(o.trigger)) return null;
  if (typeof o.command !== "string" || o.command.trim() === "") return null;
  if (o.timeout !== undefined && (typeof o.timeout !== "number" || !Number.isFinite(o.timeout) || o.timeout <= 0)) {
    return null;
  }
  const matcher = o.matcher;
  if (matcher !== undefined) {
    if (typeof matcher !== "object" || matcher === null) return null;
    const m = matcher as Record<string, unknown>;
    if (m.tool !== undefined && typeof m.tool !== "string") return null;
    if (m.path !== undefined && typeof m.path !== "string") return null;
    if (m.tool === undefined && m.path === undefined) return null;
  }
  if (!isHookOn(o.on)) return null;
  if (o.enabled !== undefined && typeof o.enabled !== "boolean") return null;
  if (o.description !== undefined && typeof o.description !== "string") return null;
  if (o.network !== undefined && typeof o.network !== "boolean") return null;

  const hook: HookManifest = {
    id: o.id,
    trigger: o.trigger,
    command: o.command,
  };
  if (matcher !== undefined) {
    const m = matcher as Record<string, unknown>;
    hook.matcher = {
      ...(typeof m.tool === "string" ? { tool: m.tool } : {}),
      ...(typeof m.path === "string" ? { path: m.path } : {}),
    };
  }
  if (typeof o.timeout === "number") hook.timeout = o.timeout;
  if (o.on !== undefined) hook.on = { ...(o.on as HookOn) };
  if (o.enabled !== undefined) hook.enabled = o.enabled;
  if (typeof o.description === "string") hook.description = o.description;
  if (o.network !== undefined) hook.network = o.network;
  if (file) hook.file = file;
  return hook;
}

/** Default audit value: a hook records an audit line unless it opts out. */
export function wantsAudit(hook: HookManifest): boolean {
  return hook.on?.audit !== false;
}

/** PreToolUse veto power is intrinsic to the trigger; `on.block` is advisory. */
export function canBlock(hook: HookManifest): boolean {
  return hook.trigger === "PreToolUse" || hook.trigger === "UserPromptSubmit";
}

export function canModify(hook: HookManifest): boolean {
  return hook.on?.modify === true && (hook.trigger === "PreToolUse" || hook.trigger === "PostToolUse");
}