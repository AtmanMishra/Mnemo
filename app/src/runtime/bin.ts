/**
 * Programs Mnemo starts on its own, before anyone has trusted the folder it is in.
 *
 * Opening a folder must run nothing the folder chose. Two ways it otherwise could:
 * a bare `git` or `taskkill` is looked up in the current folder first on Windows,
 * so a repository can ship its own `git.exe`; and git runs commands its config
 * names (`core.fsmonitor` on `ls-files` and `stash`, hooks on `worktree add`),
 * and a downloaded folder can carry that config in its `.git`.
 */
import * as path from "node:path";

type Env = Record<string, string | undefined>;

/**
 * `name` found on PATH's absolute entries only, never in the current folder; undefined when
 * none has it. A relative entry (`.`, or the empty one) would mean whatever folder Mnemo is in.
 */
export function trustedBin(name: string, env: Env = process.env): string | undefined {
  const sep = process.platform === "win32" ? ";" : ":";
  const PATH = (env.PATH ?? env.Path ?? "")
    .split(sep)
    .filter((d) => d && path.isAbsolute(d))
    .join(sep);
  return Bun.which(name, { PATH }) ?? undefined;
}

/**
 * git with the repository's own commands turned off: no fsmonitor, no hooks. Prepend to
 * every git argument list Mnemo builds itself (not to commands the model runs).
 */
export const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`];
