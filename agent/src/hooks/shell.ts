/**
 * AREA 9.2 — which shell runs a hook's command (issue #2).
 *
 * The executor used to spawn `sh -c` unconditionally. On Windows there is no
 * `sh`, so every hook invocation died at the spawn and the exit-code contract
 * (0 allow / 2 block / anything else an audited error) could never be
 * evaluated there. The engine now resolves a real shell through the SAME
 * helper the bash tool uses (tools/shell.ts):
 *
 *   1. the manifest's own `shell` field (this hook only);
 *   2. MNEMO_SHELL;
 *   3. pi's global `shellPath` setting;
 *   4. the platform default — `sh -c` on POSIX, `cmd.exe /d /s /c` on Windows.
 *
 * A manifest that declares `shell: "bash"` gets a real bash (`-c`), which is
 * how a POSIX hook keeps working on a Windows machine that has Git Bash.
 *
 * Resolution can legitimately fail: an override that does not exist (which
 * resolveShell refuses rather than silently falling back), `shell: "bash"`
 * with no bash anywhere, `shell: "cmd"` on a machine with no cmd.exe. It
 * THROWS with a message naming what was looked for; executeHook turns that
 * into the engine's audited-error outcome, so a broken shell never crashes a
 * tool call and never silently allows one either.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IS_WINDOWS, resolveShell, shellLabel } from "../tools/shell.ts";
import type { Hook, HookManifest } from "./types.ts";

/** How a shell takes a command line: `<file> -c <cmd>` or `cmd.exe /d /s /c <cmd>`. */
export type ShellKind = "posix" | "cmd";

export interface ShellChoice {
  /** Value to hand child_process.spawn({ shell }); `true` = Node's platform handling. */
  shell: true | string;
  kind: ShellKind;
  /** Human label for messages/logs, e.g. "cmd.exe /d /s /c". */
  label: string;
  source: "hook" | "mnemo-shell" | "pi-shellpath" | "platform-default";
}

const CMD_NAMES = new Set(["cmd", "cmd.exe", "command.com"]);
/** Names that mean "a POSIX shell": resolved to a real binary, run with -c. */
const POSIX_NAMES = new Set(["bash", "bash.exe", "sh", "sh.exe", "dash", "zsh"]);

function baseOf(p: string): string {
  return path.basename(p.trim()).toLowerCase();
}

/** True when the file is (or names) cmd.exe, whatever platform we are on. */
export function isCmdShell(file: string): boolean {
  return CMD_NAMES.has(baseOf(file));
}

/** True for the bare names / paths that mean a POSIX shell (bash, sh, ...). */
export function isPosixShellName(value: string): boolean {
  return POSIX_NAMES.has(baseOf(value));
}

/** `cmd` for cmd.exe, `posix` for everything that takes -c. */
export function shellKindOf(file: string): ShellKind {
  return isCmdShell(file) ? "cmd" : "posix";
}

/** A path (absolute or containing a separator) rather than a name to look up. */
function looksLikePath(value: string): boolean {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

/** First existing `<dir>/<name>` across PATH (Windows also tries the usual exts). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.PATH ?? env.Path ?? "";
  const names = IS_WINDOWS ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = path.join(dir, n);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* unreadable PATH entry: skip */ }
    }
  }
  return undefined;
}

/** The configured shell (MNEMO_SHELL / pi shellPath) when it is a POSIX shell. */
function configuredPosixShell(env: NodeJS.ProcessEnv, home: string): string | undefined {
  try {
    const r = resolveShell(env, home);
    const file = r.shell === true ? undefined : r.shell;
    return file && isPosixShellName(file) ? file : undefined;
  } catch {
    // an override pointing nowhere is the *global* problem; a hook that names
    // its own shell can still be served from PATH (resolveShell's complaint
    // surfaces for every hook that did not name one)
    return undefined;
  }
}

/**
 * The shell for one hook invocation. Throws (never crashes) when the choice
 * cannot be resolved to something runnable.
 */
export function resolveHookShell(
  hook: Hook | HookManifest,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ShellChoice {
  const declared = (hook.shell ?? "").trim();
  if (declared) return declaredShell(hook, declared, env, home);

  const base = resolveShell(env, home); // throws for a broken override, by contract
  if (base.shell === true) {
    return IS_WINDOWS
      ? { shell: true, kind: "cmd", label: "cmd.exe /d /s /c (the Windows system shell)", source: "platform-default" }
      : { shell: true, kind: "posix", label: "sh -c (/bin/sh)", source: "platform-default" };
  }
  return { shell: base.shell, kind: shellKindOf(base.shell), label: base.label, source: base.source };
}

function declaredShell(
  hook: Hook | HookManifest,
  declared: string,
  env: NodeJS.ProcessEnv,
  home: string,
): ShellChoice {
  const id = hook.id;

  if (isCmdShell(declared)) {
    const file = looksLikePath(declared) ? declared : env.ComSpec?.trim() || env.COMSPEC?.trim() || "cmd.exe";
    if (looksLikePath(file) && !fs.existsSync(file)) {
      throw new Error(`hook ${id}: shell "${declared}" does not exist`);
    }
    return { shell: file, kind: "cmd", label: `cmd.exe (${file})`, source: "hook" };
  }

  if (isPosixShellName(declared)) {
    const file =
      configuredPosixShell(env, home) ??
      findOnPath(declared, env) ??
      findOnPath("bash", env) ??
      findOnPath("sh", env);
    if (!file) {
      throw new Error(
        `hook ${id}: shell "${declared}" needs a POSIX shell, but no bash/sh was found — ` +
        `install one, or point MNEMO_SHELL (or pi's shellPath setting) at it`,
      );
    }
    return { shell: file, kind: "posix", label: shellLabel(file), source: "hook" };
  }

  // Anything else: an explicit interpreter that takes -c.
  if (looksLikePath(declared) && !fs.existsSync(declared)) {
    throw new Error(`hook ${id}: shell "${declared}" does not exist`);
  }
  return { shell: declared, kind: shellKindOf(declared), label: shellLabel(declared), source: "hook" };
}
