/**
 * AREA 9.3 — the hook engine: trigger semantics on top of pi's events.
 *
 * The engine itself is pi-agnostic: `attachHooks()` wires it onto any
 * event-like surface (the real ExtensionAPI in production, a map of fake
 * handlers in tests). Each trigger maps to the exact semantics from the
 * Part A spec:
 *
 *   PreToolUse       tool_call     — run matching hooks in precedence order,
 *                                   any block veto wins (first one reports
 *                                   the reason); allow+args rewrites the
 *                                   tool input in place
 *   PostToolUse      tool_result   — run matching hooks; allow+content/
 *                                   details/isError patches the result
 *   UserPromptSubmit input         — block (handled+notify), or transform
 *                                   the text
 *   TurnEnd / SessionStart /
 *   SessionShutdown                — observation: exit codes logged, never
 *                                   blocking
 *
 * A fresh registry is built per event from the event's cwd, so a hook added
 * or disabled mid-session takes effect immediately. All roots are injected.
 */
import * as os from "node:os";
import { HookRegistry } from "./registry.ts";
import { matchesHook } from "./matcher.ts";
import { executeHook, responsePatches, type ExecOutcome } from "./executor.ts";
import { HookAudit, type AuditAttrs, type AuditSink } from "./audit.ts";
import { canModify, type Hook, type Trigger } from "./types.ts";
import { REDACTED, redactString } from "../trace.ts";

/**
 * 12.10 (fa244d3f): a hook's block reason is model-visible text that may echo
 * tool args or anything a script read. The trace redactor only knows named
 * shapes, so a high-entropy string (a token, a key, any 32+ char blob) would
 * persist to ~/.mnemo/logs verbatim. This runs the reason through the same
 * redaction as other values PLUS a high-entropy scrub, so echoed secrets stay
 * off disk while the prose survives.
 */
const HIGH_ENTROPY = /\b[A-Za-z0-9_\-]{32,}\b/g;

function auditSafeReason(reason: string): string {
  return redactString(reason).replace(HIGH_ENTROPY, REDACTED).slice(0, 400);
}

export interface EngineOptions {
  /** User home: user + global hook roots. Defaults to os.homedir(). */
  home?: string;
  stateHome?: string;
  env?: NodeJS.ProcessEnv;
  audit?: AuditSink;
  /** Called at SessionStart so 9.6 can index hooks into memory. */
  onSessionStart?: (cwd?: string) => Promise<void>;
}

export interface ToolCallEventLike {
  toolCallId?: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultEventLike {
  toolCallId?: string;
  toolName: string;
  input: Record<string, unknown>;
  content?: unknown[];
  details?: unknown;
  isError?: boolean;
}

export interface PreToolUseDecision {
  block?: boolean;
  reason?: string;
}

export interface PostToolUsePatch {
  content?: unknown[];
  details?: unknown;
  isError?: boolean;
}

export type PromptDecision =
  | { action: "continue" }
  | { action: "handled"; reason: string }
  | { action: "transform"; text: string };

/** One invocation record, kept for audit + tests. */
export interface Invocation {
  hook: Hook;
  outcome: ExecOutcome;
  matched: boolean;
  tool?: string;
  cwd?: string;
}

export class HookEngine {
  readonly audit: AuditSink;
  private readonly home: string;
  private readonly stateHome: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onSessionStart?: (cwd?: string) => Promise<void>;

  constructor(opts: EngineOptions = {}) {
    this.home = opts.home ?? os.homedir();
    this.stateHome = opts.stateHome ?? this.home;
    this.env = opts.env ?? process.env;
    this.audit = opts.audit ?? new HookAudit({ home: this.home });
    this.onSessionStart = opts.onSessionStart;
  }

  /** Fresh registry for an event's cwd: live hooks, live disabled set. */
  registry(cwd?: string): HookRegistry {
    return new HookRegistry({
      scan: { home: this.home, project: cwd },
      stateOwner: this.stateHome,
      disabled: undefined,
    });
  }

  /** Matching hooks for a trigger in precedence order. */
  matching(trigger: Trigger, ev: { toolName: string; input: Record<string, unknown> }, cwd?: string): Hook[] {
    return this.registry(cwd).hooks().filter(
      (h) => h.trigger === trigger && matchesHook({ toolName: ev.toolName, input: ev.input }, h.matcher),
    );
  }

  private auditInvocation(hook: Hook, attrs: Partial<AuditAttrs>): void {
    const scrubbed = { ...attrs };
    // 12.10: a hook block reason may echo arbitrary bytes; scrub before
    // it reaches the audit sink / trace file
    if (typeof scrubbed.reason === "string") scrubbed.reason = auditSafeReason(scrubbed.reason);
    this.audit.event("hook", {
      hook: hook.id,
      scope: hook.scope,
      trigger: hook.trigger,
      command: hook.file ? hook.file : hook.command,
      ...scrubbed,
    } as AuditAttrs);
  }

  private cwdOf(ev: { cwd?: string }): string | undefined {
    return ev.cwd;
  }

  /** PreToolUse: vet + rewrite. Returns {block, reason} or undefined = allow. */
  async preToolUse(ev: ToolCallEventLike, ctx: { cwd?: string } = {}): Promise<PreToolUseDecision | undefined> {
    const cwd = this.cwdOf(ctx);
    const hooks = this.matching("PreToolUse", ev, cwd);
    for (const hook of hooks) {
      const outcome = await executeHook({
        hook,
        payload: { tool: ev.toolName, toolCallId: ev.toolCallId, args: ev.input ?? {}, cwd },
        env: this.env,
      });
      const modified = outcome.status === "allow" && responsePatches(outcome.response, "PreToolUse");
      this.auditInvocation(hook, {
        tool: ev.toolName,
        matched: true,
        exit: outcome.status === "error" ? outcome.exit : outcome.exit,
        duration_ms: outcome.durationMs,
        timed_out: outcome.status === "error" && outcome.timedOut,
        block: outcome.status === "block",
        reason: outcome.status === "block" ? outcome.reason : outcome.status === "error" ? outcome.message : undefined,
        modified,
      });
      if (outcome.status === "block") return { block: true, reason: outcome.reason };
      if (outcome.status === "allow" && modified && canModify(hook)) {
        const args = outcome.response!.args;
        if (args && typeof args === "object" && !Array.isArray(args)) {
          for (const k of Object.keys(ev.input)) delete ev.input[k];
          Object.assign(ev.input, args as Record<string, unknown>);
        }
      }
    }
    return undefined;
  }

  /** PostToolUse: annotate/modify the result. Returns a partial patch. */
  async postToolUse(ev: ToolResultEventLike, ctx: { cwd?: string } = {}): Promise<PostToolUsePatch | undefined> {
    const cwd = this.cwdOf(ctx);
    const hooks = this.matching("PostToolUse", ev, cwd);
    const patch: PostToolUsePatch = {};
    for (const hook of hooks) {
      const outcome = await executeHook({
        hook,
        payload: {
          tool: ev.toolName,
          toolCallId: ev.toolCallId,
          args: ev.input ?? {},
          result: { content: ev.content, details: ev.details, isError: ev.isError },
          cwd,
        },
        env: this.env,
      });
      const modified =
        outcome.status === "allow" && (outcome.response?.content !== undefined ||
          outcome.response?.details !== undefined || outcome.response?.isError !== undefined);
      this.auditInvocation(hook, {
        tool: ev.toolName,
        matched: true,
        exit: outcome.exit,
        duration_ms: outcome.durationMs,
        timed_out: outcome.status === "error" && outcome.timedOut,
        block: outcome.status === "block",
        reason: outcome.status === "block" ? outcome.reason : outcome.status === "error" ? outcome.message : undefined,
        modified,
      });
      if (modified && canModify(hook)) {
        const resp = outcome.response!;
        if (resp.content !== undefined) patch.content = resp.content as unknown[];
        if (resp.details !== undefined) patch.details = resp.details;
        if (resp.isError !== undefined) patch.isError = resp.isError as boolean;
      }
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
  }

  /** UserPromptSubmit: veto or transform the prompt before the agent sees it. */
  async userPrompt(text: string, ctx: { cwd?: string } = {}): Promise<PromptDecision> {
    const cwd = this.cwdOf(ctx);
    const ev = { toolName: "__prompt__", input: {} };
    const hooks = this.matching("UserPromptSubmit", ev, cwd);
    for (const hook of hooks) {
      const outcome = await executeHook({ hook, payload: { prompt: text, cwd }, env: this.env });
      this.auditInvocation(hook, {
        exit: outcome.exit,
        duration_ms: outcome.durationMs,
        timed_out: outcome.status === "error" && outcome.timedOut,
        block: outcome.status === "block",
        reason: outcome.status === "block" ? outcome.reason : outcome.status === "error" ? outcome.message : undefined,
        modified: outcome.status === "allow" && outcome.response?.prompt !== undefined,
      });
      if (outcome.status === "block") return { action: "handled", reason: outcome.reason };
      if (outcome.status === "allow" && typeof outcome.response?.prompt === "string") {
        return { action: "transform", text: outcome.response!.prompt as string };
      }
    }
    return { action: "continue" };
  }

  /** Observational triggers: exit codes are audited, never blocking. */
  async observe(trigger: Extract<Trigger, "TurnEnd" | "SessionStart" | "SessionShutdown">, payload: Record<string, unknown>, ctx: { cwd?: string } = {}): Promise<void> {
    const cwd = this.cwdOf(ctx);
    const ev = { toolName: `__${trigger}__`, input: {} };
    const hooks = this.matching(trigger, ev, cwd);
    for (const hook of hooks) {
      const outcome = await executeHook({ hook, payload: { ...payload, cwd }, env: this.env });
      this.auditInvocation(hook, {
        exit: outcome.exit,
        duration_ms: outcome.durationMs,
        timed_out: outcome.status === "error" && outcome.timedOut,
        block: outcome.status === "block",
        reason: outcome.status === "block" ? outcome.reason : outcome.status === "error" ? outcome.message : undefined,
      });
    }
    if (trigger === "SessionStart" && this.onSessionStart) {
      await this.onSessionStart(cwd);
    }
  }
}

/** Build one payload for the /hook test dry-run (mirrors preToolUse). */
export function testPayload(trigger: Trigger, tool: string, args: Record<string, unknown>, cwd?: string): Record<string, unknown> {
  return trigger === "UserPromptSubmit"
    ? { prompt: String(args.prompt ?? ""), cwd }
    : trigger === "PostToolUse"
      ? { tool, toolCallId: "test", args, result: { content: [], details: {}, isError: false }, cwd }
      : { tool, toolCallId: "test", args, cwd };
}
// --- pi adapter -------------------------------------------------------------

/** Minimal surface the adapter needs; the real ExtensionAPI satisfies it. */
export interface PiLike {
  on(name: string, h: (...args: any[]) => any): void;
}

/**
 * Wire the engine onto pi's events (tool_call, tool_result, input, and the
 * lifecycle trio). Tests drive the SAME adapter through a fake PiLike.
 */
export function attachHooks(pi: PiLike, engine: HookEngine): void {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const dec = await engine.preToolUse(event, { cwd: ctx?.cwd });
    return dec?.block ? { block: true, reason: dec.reason } : undefined;
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    return await engine.postToolUse(event, { cwd: ctx?.cwd });
  });

  pi.on("input", async (event: any, ctx: any) => {
    const d = await engine.userPrompt(String(event?.text ?? ""), { cwd: ctx?.cwd });
    if (d.action === "handled") {
      ctx?.ui?.notify?.(`Hook blocked your prompt: ${d.reason}`, "error");
      return { action: "handled" };
    }
    if (d.action === "transform") return { action: "transform", text: d.text };
    return undefined;
  });

  pi.on("turn_end", async (event: any, ctx: any) => {
    await engine.observe("TurnEnd", {
      turnIndex: event?.turnIndex,
      stopReason: (event?.message as any)?.stopReason,
    }, { cwd: ctx?.cwd });
  });

  pi.on("session_start", async (event: any, ctx: any) => {
    await engine.observe("SessionStart", { reason: event?.reason }, { cwd: ctx?.cwd });
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    await engine.observe("SessionShutdown", { reason: event?.reason }, { cwd: ctx?.cwd });
  });
}
