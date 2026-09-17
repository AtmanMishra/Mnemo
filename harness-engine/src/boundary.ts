/**
 * The EXECUTION BOUNDARY for harness bundles (issue #7).
 *
 * What this file is: the thing that runs a bundle's `execute()` somewhere other
 * than the agent's own process. A bundle is third-party code (model-authored,
 * therefore prompt-injectable) and the safety gate in `safety.ts` is a *lexical*
 * filter on what gets loaded — it cannot constrain what a loaded tool does. This
 * is the runtime half.
 *
 * ── What the boundary DOES prevent ────────────────────────────────────────────
 *  - **Blast radius.** A bundle that crashes, throws, exits, or loops forever
 *    cannot take the host with it. The host survives a segfault-equivalent, a
 *    `process.exit`, and an infinite loop (wall-clock timeout + tree kill).
 *  - **Secret exposure through the environment.** The child gets an EXPLICIT
 *    allowlist of environment variable names (`DEFAULT_ENV_ALLOWLIST`), never an
 *    inherited copy. An `ANTHROPIC_API_KEY` / `*_TOKEN` / `*_SECRET` in the
 *    parent's env is not in the child's env — and a credential-shaped name is
 *    refused even if a caller puts it on the allowlist, fail-closed.
 *  - **Accidental relative-path damage.** The child's cwd is the bundle
 *    directory, not the agent's cwd, so `writeFileSync("out.json")` lands in the
 *    bundle instead of the user's project root.
 *  - **The TOCTOU window, mostly.** The gate runs on the host over the on-disk
 *    source AND again inside the child immediately before the import, so a file
 *    swapped between the two is caught by the second pass.
 *  - **Unbounded output.** stdout/stderr are captured with a byte cap, so a
 *    bundle printing in a loop cannot exhaust the host's memory through its
 *    pipes.
 *
 * ── What the boundary does NOT prevent (it is NOT a sandbox) ──────────────────
 *  - **Filesystem access.** The child is the same user. An allowlisted
 *    `node:fs` (or any of the gate's escape hatches) reads and writes anything
 *    the user can, ANYWHERE — the cwd jail is a default, not a wall.
 *  - **Network access.** `fetch()` is a global; no import to scan. The child has
 *    the same network reach as the host.
 *  - **Resource exhaustion of the machine.** The timeout bounds WALL CLOCK, not
 *    memory, CPU, or disk. A bundle can allocate until the OS says no, or fork
 *    via an allowlisted `child_process`.
 *  - **Reading the host's files through inheritance.** File descriptors are
 *    `pipe`-only here, but the child can still open `/proc/<ppid>/environ` or a
 *    key file by path on a permissive OS.
 *  - **Deterministic cleanup of bundle-spawned grandchildren.** SIGKILL /
 *    `taskkill /T` takes the tree the OS still knows about; a grandchild that
 *    double-forked or detached is beyond it.
 *
 * The honest summary: this is *blast-radius control and secret hiding*, not
 * isolation. Real isolation is a container, a VM, or `node --permission` with a
 * read-only mount — see the README's "Execution boundary" section.
 *
 * Design decision (why a child process and not a worker/container): a child is
 * the only boundary that is portable across Windows/macOS/Linux without a new
 * dependency in a package that has ZERO runtime dependencies, it can be killed
 * as a TREE, and it is the only one that can be given a different ENVIRONMENT —
 * which is where the agent's API keys live. A `worker_thread` shares the env. A
 * container is right for a hostile-input service, not for a local agent that
 * must still run on a laptop.
 *
 * Tree termination mirrors `agent/src/mcp.ts` `terminateTree()` deliberately —
 * same TearDownTarget/KillSystem shape, same graceful-then-forced escalation
 * (SIGTERM -> SIGKILL on POSIX, `taskkill /T` -> `taskkill /T /F` on Windows) —
 * so the platform quirks are solved once, in the same way, in both places.
 * harness-engine cannot import that file (it is a standalone package with no
 * dependency on the agent), so the approach is mirrored rather than shared.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Env names whose value is a credential, whatever the value looks like.
 * Same shape as `agent/src/childenv.ts`'s SECRET_ENV_NAME: an exact suffix.
 */
export const SECRET_ENV_NAME = /(^|_)(API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;

/**
 * Env names that change what the child RUNS (loader/injection vectors) rather
 * than what it knows. Refused even when a caller allowlists them: honouring one
 * would let the host's inherited environment decide the child's behaviour, which
 * is the thing the boundary exists to prevent.
 */
export const INJECTION_ENV_NAMES: readonly string[] = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
];

/**
 * The ONLY environment names the boundary hands a child by default. This is an
 * allowlist, not a denylist: anything not named here does not reach the bundle,
 * which is what makes the API-key property structural rather than a pattern
 * match. The list is the minimum a Node process needs to start and to resolve
 * its own paths on Windows, macOS and Linux.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
];

/** Wall-clock limit for one bundle call. */
export const DEFAULT_BOUNDARY_TIMEOUT_MS = 30_000;
/** Grace given to a child that ignores the polite signal, ms. */
export const DEFAULT_BOUNDARY_GRACE_MS = 500;
/** Bytes of stdout/stderr kept (the first N; the rest is dropped and flagged). */
export const DEFAULT_BOUNDARY_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface EnvScrubReport {
  /** The environment the child will actually get. */
  env: Record<string, string>;
  /** Allowlisted names that were absent from the source env. */
  missing: string[];
  /** Names dropped because they were not on the allowlist (the point of it). */
  dropped: string[];
  /** Allowlisted names dropped anyway because they LOOK like credentials. */
  refused: string[];
}

/**
 * Build a child environment from an allowlist. Fail-closed twice over: a name
 * not on the list never passes, and a credential-shaped or injection-shaped name
 * is refused even when the caller asked for it.
 */
export function scrubChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
): EnvScrubReport {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  const refused: string[] = [];
  const keep = new Set(allowlist);
  const refuse = (name: string): boolean => SECRET_ENV_NAME.test(name) || INJECTION_ENV_NAMES.includes(name);
  for (const name of allowlist) {
    if (refuse(name)) refused.push(name);
  }
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!keep.has(name)) continue;
    if (refuse(name)) continue; // refused above, reported once
    env[name] = value;
  }
  for (const name of allowlist) {
    if (refuse(name)) continue;
    if (!(name in env) && !(name in source)) missing.push(name);
  }
  return { env, missing, dropped: [], refused };
}

/** The scrubbed child environment, without the report. */
export function scrubbedEnv(
  source: NodeJS.ProcessEnv = process.env,
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
): Record<string, string> {
  return scrubChildEnv(source, allowlist).env;
}

/** What terminateChildTree needs to know about one process. */
export interface TearDownTarget {
  /** The tree leader's pid, or undefined when the spawn produced no pid. */
  pid?: number | undefined;
  /** True while the process is still running. */
  alive(): boolean;
  /** Called (once) if/when the process ends on its own. */
  onExit(listener: () => void): void;
  /** Last-ditch direct kill, used only when the tree action cannot be delivered. */
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * The OS actions that end a process tree. Injectable: tests swap in a recorder
 * so no real tree is ever signalled. Both methods are optional because a host
 * only ever needs the ones its platform uses.
 */
export interface KillSystem {
  platform: NodeJS.Platform;
  /** POSIX: signal the whole process group led by `pid`. */
  signal?(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** Windows: taskkill the tree; `force` adds /F. */
  taskkill?(pid: number, force: boolean): void;
}

export const DEFAULT_KILL_SYSTEM: KillSystem = {
  platform: process.platform,
  signal(pid, signal) {
    // Negative pid = the process GROUP. Only correct because a boundary child
    // is spawned detached on POSIX, which makes it its own group leader.
    process.kill(-pid, signal);
  },
  taskkill(pid, force) {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const r = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    const failed = r.error ? r.error.message : r.status !== 0 ? `taskkill exited ${r.status}` : undefined;
    if (failed) throw new Error(failed);
  },
};

export interface TerminationReport {
  /** True when the tree did NOT end on the graceful signal and had to be forced. */
  escalated: boolean;
  /** The action that ended (or was last used on) the tree, or "none". */
  method: string;
  /** Grace the child was given before force, ms. */
  graceMs: number;
  pid?: number | undefined;
  /** Why even the forced action could not be delivered, when it could not. */
  error?: string | undefined;
}

/** The one-line description of a termination, for logs and error text. */
export function describeTermination(r: TerminationReport): string {
  if (r.method === "none") return "the bundle process was already gone";
  if (!r.escalated) return `the bundle process exited on ${r.method}`;
  const pid = r.pid === undefined ? "" : ` (pid ${r.pid})`;
  return (
    `the bundle process ignored ${r.method === "SIGKILL" ? "SIGTERM" : "taskkill /T"} and had to be ` +
    `killed as a process tree with ${r.method}${pid} after ${r.graceMs}ms` +
    `${r.error ? `; the forced kill also failed: ${r.error}` : ""}`
  );
}

/**
 * End one child tree, gracefully then forcefully, and report which it took.
 * Always resolves — a wedged bundle must not hang the caller — and never
 * rejects. Mirrors `agent/src/mcp.ts` terminateTree().
 */
export function terminateChildTree(
  target: TearDownTarget,
  opts: { graceMs?: number; kill?: KillSystem } = {},
): Promise<TerminationReport> {
  const kill = opts.kill ?? DEFAULT_KILL_SYSTEM;
  const graceMs = opts.graceMs ?? DEFAULT_BOUNDARY_GRACE_MS;
  const win = kill.platform === "win32";
  const gracefulAction = win ? "taskkill /T" : "SIGTERM";
  const forcedAction = win ? "taskkill /T /F" : "SIGKILL";
  const pid = target.pid;

  if (pid === undefined || !target.alive()) {
    return Promise.resolve<TerminationReport>({ escalated: false, method: "none", graceMs, pid });
  }

  const act = (graceful: boolean): void => {
    if (win) {
      if (!kill.taskkill) throw new Error("no taskkill action available for this platform");
      kill.taskkill(pid, !graceful);
    } else {
      if (!kill.signal) throw new Error("no signal action available for this platform");
      kill.signal(pid, graceful ? "SIGTERM" : "SIGKILL");
    }
  };

  const force = (): TerminationReport => {
    let error: string | undefined;
    try {
      act(false);
    } catch (err: unknown) {
      error = String((err as Error)?.message ?? err);
      try { target.kill("SIGKILL"); } catch { /* already gone */ }
    }
    return { escalated: true, method: forcedAction, graceMs, pid, error };
  };

  return new Promise<TerminationReport>((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const quiet = (): TerminationReport => ({ escalated: false, method: gracefulAction, graceMs, pid });
    const finish = (r: TerminationReport): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    target.onExit(() => finish(quiet()));

    let gracefulError: string | undefined;
    try {
      act(true);
    } catch (err: unknown) {
      gracefulError = String((err as Error)?.message ?? err);
    }
    if (done) return;
    if (gracefulError !== undefined) {
      finish(target.alive() ? force() : { escalated: false, method: "none", graceMs, pid });
      return;
    }
    timer = setTimeout(() => finish(target.alive() ? force() : quiet()), graceMs);
    timer.unref?.();
  });
}

export interface BoundaryOptions {
  /** Wall-clock limit for the whole child run. Default 30s. */
  timeoutMs?: number;
  /** Grace before force, ms. Default 500. */
  graceMs?: number;
  /**
   * Env var NAMES the child may inherit (default {@link DEFAULT_ENV_ALLOWLIST}),
   * or a literal env object to use as-is (tests, or a caller that wants to hand
   * a bundle a specific value — the value still passes the credential-name
   * check only by name, so pass real secrets only if you mean it).
   */
  env?: readonly string[] | Record<string, string>;
  /** Child working directory. Defaults to the bundle dir — the cwd jail. */
  cwd?: string;
  /** Bytes of stdout/stderr kept. Default 1 MiB each. */
  maxOutputBytes?: number;
  /** Node executable. Default `process.execPath` (the node running the host). */
  nodePath?: string;
  /** Extra node args for the child, e.g. ["--permission"]. */
  nodeArgs?: readonly string[];
  /** How long to wait for the tree's pipes to close after a timeout kill. Default 2000. */
  settleMs?: number;
  /** Injectable kill system (tests). */
  kill?: KillSystem;
}

/** The request the host sends a boundary child on stdin. */
export interface ChildRequest {
  mode: "describe" | "execute";
  /** Bundle directory: the child's cwd AND the gate's rootDir. */
  dir: string;
  /** Tool file refs relative to `dir` (describe mode). */
  refs?: string[];
  /** Module specifiers the host's gate allowed through. */
  allowModules?: string[];
  /** Tool name to run (execute mode). */
  tool?: string;
  /** Params object for the tool call (execute mode). */
  params?: unknown;
  /** Absolute path the child must write its result frame to. */
  resultPath: string;
}

export interface ChildToolDescription {
  ref: string;
  name: string;
  description?: string;
  schema: unknown;
}

export interface ChildResponse {
  ok: boolean;
  error?: string;
  tools?: ChildToolDescription[];
  /** The tool's return value, stringified by the child. */
  result?: string;
  /** The child's own report of its environment (NAMES ONLY) — the scrub audit. */
  envNames?: string[];
  /** The child's own cwd — the cwd-jail audit. */
  cwd?: string;
  /** The node version the bundle ran under. */
  node?: string;
}

/** The request a CALLER sends. The result path is the boundary's business. */
export type HostChildRequest = Omit<ChildRequest, "resultPath"> & { resultPath?: string };

/** How a bounded child run ended. */
export type ChildRunStatus = "ok" | "failed" | "timeout" | "spawn-error";

export interface ChildRunResult {
  status: ChildRunStatus;
  /** The child's result frame, when it managed to write one. */
  response?: ChildResponse;
  error?: string;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: { stdout: boolean; stderr: boolean };
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  cwd: string;
  /** Env NAMES the child attests it had (from the child, not from the host). */
  childEnvNames: string[];
  /** Allowlisted names refused for looking like credentials or a loader hijack. */
  envRefused: string[];
  pid?: number | undefined;
  termination?: TerminationReport;
}

/** Absolute path of the child entry point (this package, same node strips .ts). */
export function childRunnerPath(): string {
  return fileURLToPath(new URL("./child-runner.ts", import.meta.url));
}

/**
 * Run one request in a boundary child. Never throws for bundle behaviour: a
 * crash, a non-zero exit, a timeout and a missing result frame all come back as
 * a `ChildRunResult` so the caller can REPORT what the bundle said instead of
 * swallowing it. The host's own plumbing failures (a spawn that never happened)
 * are a result too — `status: "spawn-error"` — because "the boundary could not
 * even start" is exactly the kind of silence this issue exists to end.
 */
export async function runInChild(
  hostRequest: HostChildRequest,
  opts: BoundaryOptions = {},
): Promise<ChildRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BOUNDARY_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_BOUNDARY_MAX_OUTPUT_BYTES;
  const nodePath = opts.nodePath ?? process.execPath;
  const started = Date.now();

  // The result frame lands in a scratch dir the bundle code cannot guess (it is
  // not in argv or in the child's env — the request arrives on stdin, which the
  // bundle never gets to read). Removed on every path, including the timeout.
  const scratch = hostRequest.resultPath ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "harness-boundary-"));
  const request: ChildRequest = {
    ...hostRequest,
    resultPath: hostRequest.resultPath ?? path.join(scratch!, "result.json"),
  };

  // The env the child gets: an explicit allowlist, never an inherited copy.
  const envReport: EnvScrubReport = Array.isArray(opts.env)
    ? scrubChildEnv(process.env, opts.env)
    : {
        env: { ...((opts.env as Record<string, string> | undefined) ?? scrubbedEnv()) },
        missing: [],
        dropped: [],
        refused: [],
      };
  // The cwd jail: the bundle dir unless the caller says otherwise. Never the
  // host's cwd by accident.
  const cwd = path.resolve(opts.cwd ?? request.dir);

  try {
    return await runChildOnce(request, opts, {
      started, timeoutMs, maxOutputBytes, nodePath, cwd, envReport,
    });
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
}

interface RunContext {
  started: number;
  timeoutMs: number;
  maxOutputBytes: number;
  nodePath: string;
  cwd: string;
  envReport: EnvScrubReport;
}

/** One spawn, one result. Scratch-dir lifecycle lives in runInChild. */
async function runChildOnce(
  request: ChildRequest,
  opts: BoundaryOptions,
  run: RunContext,
): Promise<ChildRunResult> {
  const { started, timeoutMs, maxOutputBytes, nodePath, cwd, envReport } = run;
  const childEnv = envReport.env;

  let child: ChildProcess;
  try {
    child = spawn(nodePath, [...(opts.nodeArgs ?? []), childRunnerPath(), "--boundary"], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // POSIX: its own process GROUP, so the tree kill is a group signal.
      // (Windows: taskkill /T walks the tree itself; a new console would only
      // make the child harder to see, so detached stays off there.)
      detached: process.platform !== "win32",
    });
  } catch (err: unknown) {
    return {
      status: "spawn-error",
      error: `could not spawn the bundle child (${nodePath}): ${String((err as Error)?.message ?? err)}`,
      stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0,
      truncated: { stdout: false, stderr: false },
      exitCode: null, signal: null, timedOut: false,
      durationMs: Date.now() - started, cwd,
      childEnvNames: [], envRefused: envReport.refused,
    };
  }

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const keep = (which: "out" | "err", chunk: Buffer): void => {
    if (which === "out") {
      stdoutBytes += chunk.length;
      if (stdout.length < maxOutputBytes) {
        const room = maxOutputBytes - stdout.length;
        stdout += chunk.subarray(0, room).toString("utf8");
        if (chunk.length > room) stdoutTruncated = true;
      } else stdoutTruncated = true;
    } else {
      stderrBytes += chunk.length;
      if (stderr.length < maxOutputBytes) {
        const room = maxOutputBytes - stderr.length;
        stderr += chunk.subarray(0, room).toString("utf8");
        if (chunk.length > room) stderrTruncated = true;
      } else stderrTruncated = true;
    }
  };

  let timedOut = false;
  let spawnError: Error | undefined;
  let termination: TerminationReport | undefined;

  const target: TearDownTarget = {
    pid: child.pid,
    alive: () => child.exitCode === null && child.signalCode === null,
    onExit: (listener) => { child.once("close", listener); },
    kill: (signal) => child.kill(signal as NodeJS.Signals),
  };

  const finished = new Promise<void>((resolve) => {
    child.once("error", (err: Error) => {
      spawnError = err;
      resolve();
    });
    child.once("close", () => resolve());
  });

  child.stdout?.on("data", (c: Buffer) => keep("out", c));
  child.stderr?.on("data", (c: Buffer) => keep("err", c));

  // Deliver the request, then EOF: the child reads it whole, then loads code.
  try {
    child.stdin?.on("error", () => { /* child died before reading; the close path reports it */ });
    child.stdin?.end(JSON.stringify(request));
  } catch { /* same */ }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      void terminateChildTree(target, { graceMs: opts.graceMs, kill: opts.kill })
        .then((r) => { termination = r; })
        .then(() => resolve());
    }, timeoutMs);
    timer.unref?.();
  });

  await Promise.race([finished, timeout]);
  if (timedOut) {
    // The tree is gone (or was never there); collect the tail — but never wait
    // forever for it. A grandchild holding the stdio pipes open must not be able
    // to hang the host: that is the one thing the boundary exists to prevent.
    // Deliberately NOT unref'd: this promise has to resolve, or the caller waits
    // on a child that will never report.
    await Promise.race([finished, new Promise<void>((r) => setTimeout(r, opts.settleMs ?? 2000))]);
  }
  if (timer) clearTimeout(timer);

  // The result frame travels as a FILE, not on stdout, so a bundle cannot fake
  // it by printing, and a stdout flood cannot destroy it. It is written before
  // the child exits, so reading it here is safe.
  let response: ChildResponse | undefined;
  let readError: string | undefined;
  try {
    response = JSON.parse(await fs.readFile(request.resultPath, "utf8")) as ChildResponse;
  } catch (err: unknown) {
    readError = String((err as Error)?.message ?? err);
  }

  const exitCode = child.exitCode;
  const signal = (child.signalCode as NodeJS.Signals | null) ?? null;
  let status: ChildRunStatus;
  let error: string | undefined;
  if (timedOut) {
    status = "timeout";
    error =
      `bundle tool exceeded the ${timeoutMs}ms wall-clock limit` +
      (termination ? `; ${describeTermination(termination)}` : "");
  } else if (spawnError) {
    status = "spawn-error";
    error = `could not spawn the bundle child (${nodePath}): ${spawnError.message}`;
  } else if (response?.ok) {
    status = "ok";
  } else if (response) {
    status = "failed";
    error = response.error ?? "the bundle reported failure";
  } else {
    status = "failed";
    error = `the bundle process produced no result frame (${readError ?? "no frame written"})`;
  }

  return {
    status,
    response,
    error,
    stdout,
    stderr,
    stdoutBytes,
    stderrBytes,
    truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
    exitCode,
    signal,
    timedOut,
    durationMs: Date.now() - started,
    cwd,
    childEnvNames: response?.envNames ?? [],
    envRefused: envReport.refused,
    pid: child.pid,
    termination,
  };
}

/**
 * The one-line report a caller gets when a bounded call does not succeed: how
 * the process ended, then the boundary's reason, then what the bundle SAID (its
 * stderr, then stdout). Never empty — an unexplained failure is worse than a
 * noisy one, and "exit 1 with no output" has to look different from "the bundle
 * explained itself and the explanation is why it failed".
 */
export function describeBoundedFailure(r: ChildRunResult): string {
  const parts: string[] = [];
  parts.push(
    r.timedOut
      ? "the bundle process was killed at its wall-clock limit"
      : r.signal
        ? `the bundle process was killed by ${r.signal}`
        : `the bundle process exited ${r.exitCode ?? "without an exit code"}`,
  );
  if (r.error) parts.push(r.error);
  const said = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join("\n");
  if (said) {
    parts.push(
      `the bundle said:\n${said}${r.truncated.stderr || r.truncated.stdout ? "\n[output truncated]" : ""}`,
    );
  } else {
    parts.push("the bundle said nothing before it stopped");
  }
  return parts.join("\n");
}
