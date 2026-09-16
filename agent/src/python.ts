/**
 * Cross-platform Python interpreter resolution.
 *
 * `python3` is the POSIX name for the interpreter, and code written on POSIX
 * tends to hard-code it. Windows has no such name: the launcher is `py.exe`,
 * the interpreter is usually `python.exe`, and a bare `python3` on PATH is
 * very often the Microsoft Store alias stub — an app-execution alias that
 * prints "Python was not found" and exits 9009 instead of running anything.
 * A POSIX host with only `python` installed (a venv puts it there) gets no
 * `python3` either. Anything that spawns an interpreter — the ipy kernel, MCP
 * servers, tests — asks here instead of guessing, and the answer is a
 * candidate that actually ran.
 *
 * Resolution order:
 *   1. SEA_PYTHON — the explicit override the kernel already documents. Set
 *      but not runnable is an error, never a silent fallback.
 *   2. the platform's candidates, first one whose probe passes:
 *        Windows:   py, python, python3
 *        elsewhere: python3, python
 *      `py` first on Windows because the launcher picks the newest 3.x the
 *      way `python3` does on POSIX; `python` second (a venv or a plain
 *      install), the Store stub last — it fails its probe and is skipped.
 * No interpreter at all is an error naming SEA_PYTHON, which is the point:
 * the alternative is a kernel that dies with an opaque ENOENT on first use.
 */
import { spawnSync } from "node:child_process";

/** Runs the interpreter just enough to prove it is a working python 3. */
const PROBE_ARGS = ["-c", "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)"];

/** True when `bin` resolves to an interpreter that runs python 3. */
export function pythonRuns(bin: string): boolean {
  try {
    const res = spawnSync(bin, PROBE_ARGS, { stdio: "ignore", timeout: 20_000 });
    // ENOENT/EACCES give status null; the Store alias stub gives 9009.
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Interpreters to try, in order, for a platform. */
export function pythonCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
}

export interface ResolvePythonOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Probe override. Tests use it to pin the order without installing pythons. */
  probe?: (bin: string) => boolean;
}

/** The interpreter to spawn, or a throw naming what was tried. */
export function resolvePythonBin(opts: ResolvePythonOptions = {}): string {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? pythonRuns;
  const override = env.SEA_PYTHON?.trim();
  if (override) {
    if (!probe(override)) {
      throw new Error(
        `SEA_PYTHON points at a python that does not run: ${override} ` +
          "(it must be a python 3 interpreter on PATH or an absolute path to one)",
      );
    }
    return override;
  }
  const candidates = pythonCandidates(opts.platform);
  for (const candidate of candidates) {
    if (probe(candidate)) return candidate;
  }
  throw new Error(
    `no python 3 interpreter found (tried ${candidates.join(", ")}). ` +
      "Install one, or set SEA_PYTHON to the interpreter to use.",
  );
}
