/**
 * D7 (issue #22): which shell bash_exec actually runs commands through, and
 * how the tool tells the model the truth about it.
 *
 * The default is Node's own `shell: true` — `/bin/sh` on POSIX, `cmd.exe` on
 * Windows — because the platform default is the least surprising thing for a
 * command the model wrote for the machine it is on. That default is not
 * POSIX sh on Windows, and the old description ("run via /bin/sh -c") was a
 * promise the tool did not keep there.
 *
 * An explicit shell can be configured, with the resolution order:
 *   1. MNEMO_SHELL (Mnemo's own override);
 *   2. pi's global `shellPath` setting (~/.pi/agent/settings.json, honouring
 *      PI_CODING_AGENT_DIR) — the same knob pi's built-in bash tool reads.
 *      Only the global file: project `.pi/settings.json` needs a trust grant
 *      that non-interactive runs do not have (docs/security.md), so reading
 *      it here would run commands through a shell pi itself would ignore.
 * That is what lets a Windows user point the tool at Git Bash:
 *   set "MNEMO_SHELL=C:\Program Files\Git\bin\bash.exe"
 * from which point commands run with POSIX syntax.
 *
 * Node spawns `shell: <path>` with `-c` on POSIX and with `-c` on Windows too
 * for anything that is not cmd.exe (it only uses `/d /s /c` for cmd), so an
 * override is a real shell switch, not just a rename.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export interface ShellResolution {
  /** Value to hand child_process.spawn({ shell }). */
  shell: true | string;
  /** Where the choice came from. */
  source: "mnemo-shell" | "pi-shellpath" | "platform-default";
  /** Model-facing name of the shell, e.g. "/bin/sh" or "cmd.exe". */
  label: string;
}

/** Expand a leading ~ the way pi's settings loader does. */
export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** pi's global shellPath setting, or undefined. Unreadable settings are "unset". */
export function readPiShellPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string | undefined {
  const dir = env.PI_CODING_AGENT_DIR?.trim() || path.join(home, ".pi", "agent");
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(expandHome(dir, home), "settings.json"), "utf8"));
    const value = typeof raw?.shellPath === "string" ? raw.shellPath.trim() : "";
    return value ? expandHome(value, home) : undefined;
  } catch {
    return undefined;
  }
}

/** A short name for an explicit shell path, for the model-facing description. */
export function shellLabel(shellPath: string): string {
  const base = path.basename(shellPath).toLowerCase();
  if (base === "bash" || base === "bash.exe") {
    return IS_WINDOWS ? `Git Bash (${shellPath})` : `bash (${shellPath})`;
  }
  if (base === "cmd" || base === "cmd.exe") return `cmd.exe (${shellPath})`;
  return `the configured shell (${shellPath})`;
}

/**
 * Resolve the shell for the next command. Throws with a message naming the
 * configured path when an override does not exist — silently falling back to
 * cmd.exe would make the tool lie again, in the other direction.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ShellResolution {
  const override = env.MNEMO_SHELL?.trim() || readPiShellPath(env, home);
  if (override) {
    if (!fs.existsSync(override)) {
      const source = env.MNEMO_SHELL?.trim() ? "MNEMO_SHELL" : "pi's shellPath setting";
      throw new Error(`${source} points at a shell that does not exist: ${override}`);
    }
    return {
      shell: override,
      source: env.MNEMO_SHELL?.trim() ? "mnemo-shell" : "pi-shellpath",
      label: shellLabel(override),
    };
  }
  return IS_WINDOWS
    ? { shell: true, source: "platform-default", label: "cmd.exe (the Windows system shell, not POSIX sh)" }
    : { shell: true, source: "platform-default", label: "POSIX /bin/sh -c" };
}

/** The shell line, identical between the tool and its `command` parameter. */
function shellHint(shell: ShellResolution): string {
  if (shell.source !== "platform-default") {
    return `${shell.label}, selected by MNEMO_SHELL/shellPath`;
  }
  return IS_WINDOWS
    ? "cmd.exe, the Windows system shell — write cmd syntax, not POSIX sh. To run commands through Git Bash " +
        "instead, set MNEMO_SHELL (or pi's shellPath setting) to its bash.exe"
    : "POSIX /bin/sh -c. Override with MNEMO_SHELL or pi's shellPath setting";
}

/** Session environment line — the same variables pi documents for its bash tool. */
const ENV_HINT =
  "The command sees pi's session environment — PI_SESSION_ID, PI_SESSION_FILE, PI_PROVIDER, PI_MODEL and " +
  "PI_REASONING_LEVEL — resolved for this session, plus the AI_AGENT=pi / PI_CODING_AGENT=true markers. " +
  "Credentials are stripped from the environment.";

/**
 * The tool description the model reads. Computed from the shell the tool will
 * actually use, so the promise and the behaviour cannot drift apart.
 */
export function bashToolDescription(shell?: ShellResolution): string {
  let resolved = shell;
  if (!resolved) {
    try {
      resolved = resolveShell();
    } catch {
      // A broken override must not stop the tool from registering; the error
      // surfaces when a command is actually run.
      resolved = {
        shell: true,
        source: "platform-default",
        label: IS_WINDOWS ? "cmd.exe (the Windows system shell, not POSIX sh)" : "POSIX /bin/sh -c",
      };
    }
  }
  return (
    "Run a shell command and return stdout, stderr and exit code. " +
    "Non-zero exit codes are reported in the result, not thrown as errors.\n" +
    `Shell: ${shellHint(resolved)}.\n` +
    ENV_HINT
  );
}

/** The `command` parameter's short line, kept in step with the description. */
export function bashCommandParamHint(shell?: ShellResolution): string {
  const resolved = shell ?? (() => {
    try {
      return resolveShell();
    } catch {
      return { shell: true as const, source: "platform-default" as const, label: IS_WINDOWS ? "cmd.exe" : "sh" };
    }
  })();
  // the long label carries a platform note ("cmd.exe (the Windows system
  // shell, not POSIX sh)"); the parameter line wants just the name
  const short = resolved.label.replace(/\s*\(.*\)$/, "");
  return `Shell command to execute (run via ${short})`;
}
