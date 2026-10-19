/**
 * Hooks: commands the user (or an administrator) runs at fixed points of a session.
 *
 *   PreToolUse    after the gate allowed a call, before it runs: may refuse it
 *   PostToolUse   after a call: may add a line the model reads with its result
 *   SessionStart  when a session starts (and each sub-agent's)
 *   SessionEnd    when it ends
 *
 * They come from the managed policy's `hooks` (first, and the user cannot remove them) and
 * `$MNEMO_HOME/hooks.json`, in the shape `{"hooks": {"PreToolUse": [{"matcher": "bash",
 * "command": "…", "timeout": 30}]}}`. A folder's own hooks are not read: code from a
 * repository does not run because the repository asked (trusted `.agents/` extensions do that job).
 *
 * A hook gets the event as JSON on stdin and the same scrubbed environment as the bash tool.
 * It can refuse, never allow: the gate has already judged the call, and a hook's exit code 0
 * only lets that judgement stand. Exit 2, or `{"decision": "block", "reason": "…"}` on stdout,
 * refuses with that reason. A PreToolUse hook that fails in any other way (another exit code,
 * a timeout, a command that does not start) refuses too, since a check that did not run
 * passed nothing.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trustedBin } from "../runtime/bin.ts";
import { childEnv, configuredKeys } from "../runtime/env.ts";
import { loadManaged } from "../policy/managed.ts";
import { globMatch } from "./policy.ts";
import type { Host } from "./host.ts";

export const EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd"] as const;
export type HookEvent = (typeof EVENTS)[number];

export interface Hook {
  /** A tool-name glob for the tool events; every tool when absent. */
  matcher?: string;
  /** A shell line, or a program and its arguments run without a shell. */
  command: string | string[];
  /** Seconds; 60 when absent. */
  timeout?: number;
  /** The file it came from, for messages. */
  source: string;
}

export type Hooks = Record<HookEvent, Hook[]>;

const none = (): Hooks => ({ PreToolUse: [], PostToolUse: [], SessionStart: [], SessionEnd: [] });

/** Valid hooks of one `{"hooks": …}` value; what is wrong goes to `errors`. */
export function parseHooks(value: unknown, source: string, into: Hooks, errors: string[]): void {
  if (value === undefined) return;
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isRecord(value)) return void errors.push(`${source}: "hooks" must be an object of event names`);
  for (const [event, list] of Object.entries(value)) {
    if (!(EVENTS as readonly string[]).includes(event)) {
      errors.push(`${source}: unknown hook event "${event}" (${EVENTS.join(", ")})`);
      continue;
    }
    for (const h of Array.isArray(list) ? list : [list]) {
      const ok =
        isRecord(h) &&
        ((typeof h.command === "string" && h.command.trim() !== "") || (Array.isArray(h.command) && h.command.length > 0 && h.command.every((w) => typeof w === "string"))) &&
        (h.matcher === undefined || typeof h.matcher === "string") &&
        (h.timeout === undefined || (typeof h.timeout === "number" && h.timeout > 0));
      if (!ok) errors.push(`${source}: a ${event} hook needs "command" (a string or a list of strings), and "matcher" and "timeout" must be a string and a positive number`);
      else into[event as HookEvent].push({ matcher: h.matcher as string | undefined, command: h.command as string | string[], timeout: h.timeout as number | undefined, source });
    }
  }
}

/** The administrator's hooks, then the user's. */
export function loadHooks(host: Pick<Host, "home" | "managedFile">): { hooks: Hooks; errors: string[] } {
  const hooks = none();
  const errors: string[] = [];
  const managed = loadManaged(host.managedFile);
  if (managed && !managed.error) parseHooks(managed.hooks, managed.file, hooks, errors);
  const file = path.join(host.home, "hooks.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return { hooks, errors };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) errors.push(`${file}: expected {"hooks": {…}}`);
  else parseHooks((raw as Record<string, unknown>).hooks, file, hooks, errors);
  return { hooks, errors };
}

export interface HookRun {
  /** Undefined when it never exited (a timeout, a command that did not start). */
  code?: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/** The program and arguments a hook runs: a shell line through the system shell, found on PATH's absolute entries only. */
function argv(command: string | string[]): string[] | undefined {
  if (Array.isArray(command)) {
    const [first, ...rest] = command;
    const program = path.isAbsolute(first!) ? first : trustedBin(first!);
    return program ? [program, ...rest] : undefined;
  }
  if (process.platform === "win32") return [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `"${command}"`];
  return [trustedBin("sh") ?? "/bin/sh", "-c", command];
}

export function runHook(hook: Hook, payload: unknown, cwd: string, agentDir: string): Promise<HookRun> {
  return new Promise((resolve) => {
    const words = argv(hook.command);
    if (!words) return resolve({ stdout: "", stderr: "", error: `${String((hook.command as string[])[0])} is not on PATH` });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (run: HookRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const child = spawn(words[0]!, words.slice(1), {
      cwd,
      env: childEnv(process.env, configuredKeys(agentDir)),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: process.platform === "win32" && !Array.isArray(hook.command),
    });
    const seconds = hook.timeout ?? 60;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ stdout, stderr, error: `did not finish within ${seconds}s` });
    }, seconds * 1000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => finish({ stdout, stderr, error: e.message }));
    child.on("close", (code) => finish({ code: code ?? undefined, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const label = (h: Hook) => (Array.isArray(h.command) ? h.command.join(" ") : h.command).slice(0, 80);

/** A block from a hook's answer: exit 2, `{"decision":"block"}`, or (for checks) any failure. */
export function blockOf(hook: Hook, run: HookRun, failClosed: boolean): string | undefined {
  if (run.code === 2) return run.stderr.trim() || `refused by the hook ${label(hook)}`;
  if (run.code === 0) {
    try {
      const answer = JSON.parse(run.stdout) as { decision?: unknown; reason?: unknown };
      if (answer?.decision === "block") return typeof answer.reason === "string" && answer.reason ? answer.reason : `refused by the hook ${label(hook)}`;
    } catch {
      /* plain output: no decision */
    }
    return undefined;
  }
  if (!failClosed) return undefined;
  return `the hook ${label(hook)} (${hook.source}) failed (${run.error ?? `exit ${run.code}`}), so the call is refused${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`;
}

export function hooksExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    // Read once per session: a hook added mid-session applies from the next one, like an extension.
    const { hooks, errors } = loadHooks(host);
    let session = "";
    const matching = (event: "PreToolUse" | "PostToolUse", tool: string) => hooks[event].filter((h) => h.matcher === undefined || globMatch(h.matcher, tool));

    pi.on("session_start", async (event, ctx) => {
      session = ctx.sessionManager.getSessionId();
      for (const e of errors) ctx.ui.notify(`hooks: ${e}`, "warning");
      for (const h of hooks.SessionStart) await runHook(h, { event: "SessionStart", reason: event.reason, session, cwd: ctx.cwd, depth: host.depth }, ctx.cwd, host.agentDir);
    });

    pi.on("session_shutdown", async (event, ctx) => {
      for (const h of hooks.SessionEnd) await runHook(h, { event: "SessionEnd", reason: event.reason, session, cwd: ctx.cwd, depth: host.depth }, ctx.cwd, host.agentDir);
    });

    pi.on("tool_call", async (event, ctx) => {
      for (const h of matching("PreToolUse", event.toolName)) {
        const run = await runHook(h, { event: "PreToolUse", tool: event.toolName, input: event.input, session, cwd: ctx.cwd, depth: host.depth }, ctx.cwd, host.agentDir);
        const reason = blockOf(h, run, true);
        if (reason) return { block: true, reason: `A hook refused this call: ${reason}` };
      }
      return undefined;
    });

    pi.on("tool_result", async (event, ctx) => {
      const notes: string[] = [];
      for (const h of matching("PostToolUse", event.toolName)) {
        const payload = { event: "PostToolUse", tool: event.toolName, input: event.input, isError: event.isError, output: event.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n"), session, cwd: ctx.cwd, depth: host.depth };
        const reason = blockOf(h, await runHook(h, payload, ctx.cwd, host.agentDir), false);
        if (reason) notes.push(`A hook (${label(h)}) says: ${reason}`);
      }
      if (notes.length === 0) return undefined;
      return { content: [...event.content, { type: "text" as const, text: notes.join("\n") }] };
    });
  };
}
