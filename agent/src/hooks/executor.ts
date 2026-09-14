/**
 * AREA 9.2 — hook executor.
 *
 * Runs a hook's command with JSON on stdin and maps the exit code to policy:
 *
 *   exit 0             allow; stdout JSON is the response (args rewrite for
 *                      PreToolUse, content/details patch for PostToolUse)
 *   exit 2             BLOCK; the reason shown to the model is stderr, else
 *                      stdout, else a fallback
 *   anything else      allow + error (logged; never breaks the tool call)
 *   timeout            SIGKILL, allow + error (a stuck hook must not break
 *                      the loop)
 *
 * Commands run through `sh -c` (hooks are trusted user scripts; the shell
 * gives natural arg splitting and PATH lookup). A relative command resolves
 * against the manifest's own directory, so project hooks stay portable.
 * Duration uses an injected clock — tests never wait on real time.
 *
 * 12.10 (audit 41ab8d40) adds two bounds:
 *   - scope: a RELATIVE command may not escape the manifest's directory via
 *     `..` or a symlink (canonicalized containment); an explicit absolute
 *     path is an operator-authored choice and is left alone.
 *   - time: a manifest without a timeout gets a finite default, so a stuck
 *     hook cannot hang a tool call forever.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Hook, HookManifest } from "./types.ts";

/** What a hook invocation is allowed to return on stdout (parsed JSON). */
export interface HookResponse {
  [key: string]: unknown;
}

export interface ExecRequest {
  hook: Hook | HookManifest;
  /** JSON payload written to stdin. */
  payload: unknown;
  /** Shell working directory for the child. Defaults to the manifest dir. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable clock. */
  now?: () => number;
  /** Test override: force a timeout in ms (default: hook.timeout seconds). */
  timeoutMsOverride?: number;
}

export type ExecOutcome =
  | {
      status: "allow";
      exit: number;
      stdout: string;
      stderr: string;
      durationMs: number;
      /** Parsed JSON response from stdout, when the hook provided one. */
      response: HookResponse | null;
    }
  | {
      status: "block";
      exit: 2;
      reason: string;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      status: "error";
      message: string;
      exit: number | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
      durationMs: number;
    };

export interface ExecStats {
  invoked: number;
  errored: number;
  timedOut: number;
}

/** Block reasons are model-visible; keep them short and single-line. */
export function blockReason(hook: Hook | HookManifest, stdout: string, stderr: string): string {
  const raw = (stderr.trim() || stdout.trim()).split("\n")[0] ?? "";
  const t = raw.slice(0, 400);
  if (!t) return `blocked by hook ${hook.id}`;
  return `blocked by hook ${hook.id}: ${t}`;
}

/** Parse hook stdout as a JSON response object; null for empty/trash. */
export function parseResponse(stdout: string): HookResponse | null {
  const t = stdout.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as HookResponse) : null;
  } catch {
    return null;
  }
}

/** Resolve the command to an absolute path: relative -> manifest dir. */
export function resolveCommand(hook: Hook | HookManifest, home?: string): string {
  if (hook.command.startsWith("~/")) {
    return path.join(home ?? "", hook.command.slice(2));
  }
  if (path.isAbsolute(hook.command)) return hook.command;
  const base = hook.file ? path.dirname(hook.file) : process.cwd();
  return path.join(base, hook.command);
}

/** Timeout in ms for a hook; unset (or nonsense) -> a finite default (12.10). */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * realpath of `p`, tolerating a not-yet-existing tail: the deepest EXISTING
 * ancestor is canonicalized and the missing tail is appended verbatim.
 */
function canonicalize(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) {
        throw new Error(`hook: cannot resolve "${p}"`);
      }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 12.10 scope: the resolved command, with sneaky escapes refused.
 * A RELATIVE command must stay inside the manifest's own directory after
 * canonicalization (`..` walks and symlinked subdirs can otherwise smuggle
 * a hook out of the repo it ships in). An explicit absolute path is treated
 * as operator intent — the operator wrote it in their own manifest.
 */
export function scopeCommand(hook: Hook | HookManifest, home?: string): string {
  const command = resolveCommand(hook, home);
  if (path.isAbsolute(hook.command)) return command;
  const root = canonicalize(hook.file ? path.dirname(hook.file) : process.cwd());
  const dir = canonicalize(path.dirname(command));
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(
      `hook ${hook.id}: command "${hook.command}" resolves to ${dir}, outside the ` +
      `hook's directory (${root}). Hooks may only run commands inside their own manifest directory.`,
    );
  }
  return command;
}

/** Timeout in ms for a hook; unset -> DEFAULT_HOOK_TIMEOUT_MS. */
export function timeoutMs(hook: Hook | HookManifest): number {
  const secs = hook.timeout ?? 0;
  return secs > 0 ? secs * 1000 : DEFAULT_HOOK_TIMEOUT_MS;
}

/**
 * Run one hook. Resolves exactly once: on child 'close' (or 'error'), or on
 * timeout (which kills the child). Never hangs — every path settles.
 */
export function executeHook(req: ExecRequest): Promise<ExecOutcome> {
  const start = (req.now ?? Date.now)();
  let command: string;
  try {
    command = scopeCommand(req.hook, req.env?.HOME);
  } catch (err: any) {
    return Promise.resolve({
      status: "error",
      message: `hook ${req.hook.id} refused: ${err?.message ?? err}`,
      exit: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: (req.now ?? Date.now)() - start,
    });
  }
  const cwd = req.cwd ?? (req.hook.file ? path.dirname(req.hook.file) : process.cwd());
  const ttl = req.timeoutMsOverride ?? timeoutMs(req.hook);

  const env = { ...(req.env ?? process.env) };
  const payload = JSON.stringify(req.payload ?? {});

  return new Promise<ExecOutcome>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;

    const finish = (outcome: ExecOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    let child;
    try {
      child = spawn("sh", ["-c", command], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({
        status: "error",
        message: `hook spawn failed: ${String(err)}`,
        exit: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        durationMs: (req.now ?? Date.now)() - start,
      });
      return;
    }

    if (ttl !== null) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
        finish({
          status: "error",
          message: `hook ${req.hook.id} timed out after ${ttl}ms`,
          exit: null,
          timedOut: true,
          stdout,
          stderr,
          durationMs: (req.now ?? Date.now)() - start,
        });
      }, ttl);
      timer.unref?.();
    }

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

    // A hook that exits without reading its stdin — a common shape, e.g. "if
    // this path is under /etc, exit 2" — leaves us writing into a closed pipe.
    // Node reports that asynchronously, as an 'error' event on the stream, so
    // the try/catch below never sees it and an unhandled EPIPE takes down the
    // invocation: the exit code, which IS the answer, is lost. Swallow it. The
    // hook's exit status is the result; whether it deigned to read our payload
    // is not part of the contract.
    child.stdin?.on("error", () => { /* EPIPE: the hook did not read stdin */ });
    try {
      child.stdin?.end(payload + "\n");
    } catch { /* stdin closed by the child already */ }

    child.once("error", (err) => {
      finish({
        status: "error",
        message: `hook ${req.hook.id} failed to start: ${err.message}`,
        exit: null,
        timedOut: false,
        stdout,
        stderr,
        durationMs: (req.now ?? Date.now)() - start,
      });
    });

    child.once("close", (code) => {
      const durationMs = (req.now ?? Date.now)() - start;
      const exit = code ?? -1;
      if (exit === 0) {
        finish({ status: "allow", exit, stdout, stderr, durationMs, response: parseResponse(stdout) });
      } else if (exit === 2) {
        finish({ status: "block", exit, reason: blockReason(req.hook, stdout, stderr), stdout, stderr, durationMs });
      } else {
        finish({
          status: "error",
          message: `hook ${req.hook.id} exited ${exit}`,
          exit,
          timedOut: false,
          stdout,
          stderr,
          durationMs,
        });
      }
    });
  });
}

/** Convenience: does the response carry a modified payload for this trigger? */
export function responsePatches(resp: HookResponse | null, trigger: "PreToolUse" | "PostToolUse"): boolean {
  if (!resp) return false;
  return trigger === "PreToolUse"
    ? resp.args !== undefined
    : resp.content !== undefined || resp.details !== undefined || resp.isError !== undefined;
}