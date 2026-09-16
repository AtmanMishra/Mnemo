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
 * Commands run through a real shell on every platform (issue #2): `sh -c` on
 * POSIX, `cmd.exe /d /s /c` on Windows by default, or whatever MNEMO_SHELL /
 * pi's shellPath / the manifest's own `shell` field names (see shell.ts). The
 * shell gives natural arg splitting and PATH lookup; hooks are trusted user
 * scripts. A relative command resolves against the manifest's own directory,
 * so project hooks stay portable, and a command may name its interpreter
 * (`node bin/audit.js`) — the shell line, not just a bare executable path,
 * which is the only shape that runs on a machine with no POSIX shell. A shell
 * that cannot be resolved is an audited error outcome — the same shape as any
 * other failed invocation.
 * Duration uses an injected clock, and the timeout is armed through an
 * injected scheduler — tests never wait on real time.
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
import * as os from "node:os";
import * as path from "node:path";
import type { Hook, HookManifest } from "./types.ts";
import { resolveHookShell, type ShellChoice } from "./shell.ts";
import { IS_WINDOWS } from "../tools/shell.ts";

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
  /**
   * Test override: arm the timeout without real time. Handed the kill callback
   * and the TTL, it returns a cancel. Defaults to setTimeout — the same spirit
   * as `now`, so a test that must not race a wall clock under load fires the
   * callback itself instead of sleeping and hoping.
   */
  scheduleTimeout?: (fire: () => void, ms: number) => { cancel(): void };
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

/**
 * Split a command line into its program token and the verbatim tail. One layer
 * of quotes is removed from the program (`"C:/Program Files/node.exe" x.js`);
 * the tail is kept exactly as written, because the shell re-splits it with its
 * own quoting rules and we must not paraphrase them.
 */
export function splitCommandLine(command: string): { program: string; rest: string } {
  const s = command.trim();
  if (!s) return { program: "", rest: "" };
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    return end < 0
      ? { program: s.slice(1), rest: "" }
      : { program: s.slice(1, end), rest: s.slice(end + 1).trim() };
  }
  const m = /\s/.exec(s);
  return m ? { program: s.slice(0, m.index), rest: s.slice(m.index).trim() } : { program: s, rest: "" };
}

/** Put a program path back on a shell line, quoting it only if it needs it. */
function programLine(program: string, rest: string): string {
  const p = /\s/.test(program) ? `"${program}"` : program;
  return rest ? `${p} ${rest}` : p;
}

/**
 * Resolve the command's PROGRAM. `~/x` expands against home, an absolute path
 * stands, a relative path joins the manifest directory — that is the
 * long-standing contract for a single word like `bin/audit.sh` — and a bare
 * name is left alone for the shell to find on PATH.
 *
 * A command WITH arguments (`node bin/audit.js`) is a program line, not a
 * path: only the program token is resolved and the tail goes to the shell
 * untouched. That is what makes a hook runnable on a machine with no POSIX
 * shell — `node script.js` works everywhere (issue #2).
 */
export function resolveCommand(hook: Hook | HookManifest, home?: string): string {
  const { program, rest } = splitCommandLine(hook.command);
  if (!program) return hook.command;
  const base = hook.file ? path.dirname(hook.file) : process.cwd();
  if (program.startsWith("~/")) return programLine(path.join(home ?? "", program.slice(2)), rest);
  if (path.isAbsolute(program)) return programLine(program, rest);
  // One word: a path beside the manifest, as always. Inside a program line the
  // token `node` is a name to look up, not a file in the hooks directory.
  if (rest === "" || /[\\/]/.test(program)) return programLine(path.join(base, program), rest);
  return programLine(program, rest);
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
 * Whitespace-split a command's argument tail, removing one layer of quotes.
 * Only used for the containment check below — the shell does the real parsing.
 */
function splitArguments(rest: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const c of rest) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 12.10 scope: the resolved command, with sneaky escapes refused.
 * A RELATIVE path — the program itself when it is one, and any relative path
 * argument, which the shell resolves against the same working directory — must
 * stay inside the manifest's own directory after canonicalization (`..` walks
 * and symlinked subdirs can otherwise smuggle a hook out of the repo it ships
 * in). An explicit absolute path is treated as operator intent — the operator
 * wrote it in their own manifest.
 */
export function scopeCommand(hook: Hook | HookManifest, home?: string): string {
  const command = resolveCommand(hook, home);
  const { program, rest } = splitCommandLine(hook.command);
  const base = hook.file ? path.dirname(hook.file) : process.cwd();
  const root = canonicalize(base);

  const assertInside = (resolved: string): void => {
    const dir = canonicalize(path.dirname(resolved));
    if (dir !== root && !dir.startsWith(root + path.sep)) {
      throw new Error(
        `hook ${hook.id}: command "${hook.command}" resolves to ${dir}, outside the ` +
        `hook's directory (${root}). Hooks may only run commands inside their own manifest directory.`,
      );
    }
  };
  /** A relative path token, or null for a flag, a bare name or an absolute path. */
  const relative = (token: string): string | null => {
    if (!token || token.startsWith("-") || token.startsWith("~/")) return null;
    if (path.isAbsolute(token) || !/[\\/]/.test(token)) return null;
    return path.join(base, token);
  };

  const programPath = relative(program);
  if (programPath) assertInside(programPath);
  for (const arg of splitArguments(rest)) {
    const argPath = relative(arg);
    if (argPath) assertInside(argPath);
  }
  return command;
}

/** Timeout in ms for a hook; unset -> DEFAULT_HOOK_TIMEOUT_MS. */
export function timeoutMs(hook: Hook | HookManifest): number {
  const secs = hook.timeout ?? 0;
  return secs > 0 ? secs * 1000 : DEFAULT_HOOK_TIMEOUT_MS;
}

/**
 * How one resolved shell takes a command line: `cmd.exe /d /s /c "<line>"` or
 * `<shell> -c <line>`. This mirrors what Node's own `shell:` option does, but
 * explicitly, because shell and platform no longer have to agree — a Windows
 * machine whose hooks declare `shell: "bash"` runs `bash -c`, not `/d /s /c`.
 *
 * The extra pair of quotes around a cmd line is not decoration: with /s,
 * cmd.exe strips the first and last quote of the whole tail, so wrapping once
 * leaves an inner quoted path (`"C:/Program Files/node.exe" x.js`) intact.
 * Node wraps its own shell commands for exactly the same reason.
 */
export function shellArgv(
  choice: ShellChoice,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; verbatim: boolean } {
  if (choice.kind === "cmd") {
    const file =
      typeof choice.shell === "string"
        ? choice.shell
        : env.ComSpec?.trim() || env.COMSPEC?.trim() || "cmd.exe";
    return { file, args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
  }
  const file = typeof choice.shell === "string" ? choice.shell : IS_WINDOWS ? "sh" : "/bin/sh";
  return { file, args: ["-c", command], verbatim: false };
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

  // Arm the timeout through an injectable scheduler: the same discipline as
  // the injected clock, so the timeout path can be exercised without racing a
  // wall clock (a loaded CI box otherwise decides when the hook "started").
  const schedule =
    req.scheduleTimeout ??
    ((fire: () => void, ms: number) => {
      const t = setTimeout(fire, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });

  return new Promise<ExecOutcome>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: { cancel(): void } | null = null;

    const finish = (outcome: ExecOutcome) => {
      if (settled) return;
      settled = true;
      timer?.cancel();
      resolve(outcome);
    };

    let line: ReturnType<typeof shellArgv>;
    try {
      // The shell is resolved per invocation (issue #2): the manifest's own
      // `shell`, then MNEMO_SHELL, then pi's shellPath, then the platform
      // default. A choice that cannot be resolved is an audited error, never a
      // crash — and never a silent fall back to a shell that is not there.
      line = shellArgv(resolveHookShell(req.hook, env, req.env?.HOME ?? os.homedir()), command, env);
    } catch (err: any) {
      finish({
        status: "error",
        message: `hook ${req.hook.id} could not resolve a shell: ${err?.message ?? err}`,
        exit: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        durationMs: (req.now ?? Date.now)() - start,
      });
      return;
    }

    let child;
    try {
      child = spawn(line.file, line.args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: line.verbatim,
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
      timer = schedule(() => {
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