/**
 * The execution sandbox, client side.
 *
 * One long-lived interpreter runs `kernel/ipy_bridge.py`, which speaks JSON lines:
 * `{ id, op: "run", code }` in, `{ id, ok, result, output }` out. The namespace
 * persists for the process's lifetime, which is the whole point — a cell can
 * define a function, and the next cell can call it.
 *
 * Three properties are load-bearing, and each one is why a naive client fails:
 *
 *  1. **A hung cell costs a process, not the session.** A cell that never
 *     returns is killed and the kernel is marked dead; the next call starts a
 *     fresh interpreter. The alternative — waiting forever — loses the session
 *     and any explanation of what happened.
 *  2. **Out-of-band lines must always be answered.** Code submitted to the
 *     kernel may call host tools (`tools.read_file(...)`), which writes a
 *     `tool_call` line up the same pipe and blocks until a `tool_result` comes
 *     back. With no dispatcher attached, this client answers with an error — a
 *     kernel blocked on a reply that will never arrive is indistinguishable from
 *     a hung cell, and the user learns nothing from either.
 *  3. **An interpreter that exists is not an interpreter that runs.** On this
 *     platform `python3` resolves to a Windows Store shim that is present and
 *     does nothing; resolution therefore probes rather than trusts.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface KernelChild {
  stdin: { write(chunk: string): unknown } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): unknown;
  exitCode: number | null;
}

export type KernelSpawn = (interpreter: string, args: string[]) => KernelChild;
export type ToolDispatcher = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface KernelResult {
  ok: boolean;
  /** repr() of the last expression, when there was one and it was not None. */
  result?: string | null;
  /** stdout and stderr produced by the cell. */
  output?: string;
  /** Traceback text when ok is false. */
  error?: string;
}

export interface KernelClientOptions {
  interpreter: string;
  bridgePath: string;
  spawn: KernelSpawn;
  /** Working directory for the interpreter. */
  cwd?: string;
  /** Per-cell bound. A cell that overruns it loses the kernel, not the session. */
  timeoutMs?: number;
  /** Answers `tools.<name>(...)` calls made from inside a cell. */
  dispatch?: ToolDispatcher;
  /** Called for every line the kernel writes that is not a reply. */
  onNotice?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class KernelClient {
  #child: KernelChild | null = null;
  #nextId = 1;
  #buffer = "";
  #pending = new Map<number, (result: KernelResult) => void>();
  #queue: Promise<unknown> = Promise.resolve();
  #options: KernelClientOptions;

  constructor(options: KernelClientOptions) {
    this.#options = options;
  }

  get alive(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  /** True while an interpreter is running. A dead one restarts on the next call. */
  get running(): boolean {
    return this.alive;
  }

  /** Run one cell. Never throws: a failure is a result. */
  run(code: string): Promise<KernelResult> {
    const task = this.#queue.then(async () => {
      try {
        this.#start();
      } catch (error) {
        return { ok: false, error: `no interpreter: ${String(error)}` } as KernelResult;
      }
      return this.#send(code);
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }

  /** The kernel is gone deliberately: kill it so the next call starts clean. */
  stop(): void {
    const child = this.#child;
    this.#child = null;
    for (const [, resolve] of this.#pending) resolve({ ok: false, error: "kernel stopped" });
    this.#pending.clear();
    if (!child) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  #start(): void {
    if (this.alive) return;
    const child = this.#options.spawn(this.#options.interpreter, [
      "-u",
      this.#options.bridgePath,
    ]);
    child.stdout?.on("data", (chunk) => this.#ingest(chunk));
    child.on("exit", () => {
      // A replaced interpreter's exit arrives *after* its replacement is already
      // running — and without this check it resolved the new interpreter's
      // in-flight request with "the interpreter exited", which is a lie about
      // the wrong process. One pending map for a sequence of children is the
      // same mistake as two histories: two things that should be one.
      if (this.#child !== child) return;
      for (const [, resolve] of this.#pending) {
        resolve({ ok: false, error: "the interpreter exited before it answered" });
      }
      this.#pending.clear();
      this.#child = null;
    });
    child.on("error", (error) => {
      if (this.#child !== child) return;
      for (const [, resolve] of this.#pending) {
        resolve({ ok: false, error: `interpreter error: ${String(error)}` });
      }
      this.#pending.clear();
    });
    this.#child = child;
  }

  #send(code: string): Promise<KernelResult> {
    const child = this.#child;
    if (!child?.stdin) return Promise.resolve({ ok: false, error: "no interpreter stdin" });
    const id = this.#nextId++;
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<KernelResult>((resolve) => {
      // Not unref'd: this timer is what stops a hung cell from hanging the
      // caller forever, so it is allowed to keep the loop alive.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // The interpreter is unusable after a timeout: the cell may still be
        // running, and anything written next would queue behind it.
        this.stop();
        resolve({
          ok: false,
          error: `cell did not finish within ${timeoutMs}ms — the interpreter was restarted`,
        });
      }, timeoutMs);

      this.#pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      try {
        child.stdin!.write(`${JSON.stringify({ id, op: "run", code })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve({ ok: false, error: `could not write to the interpreter: ${String(error)}` });
      }
    });
  }

  /** Buffer, then take whole lines: a reply is not a chunk. */
  #ingest(chunk: Buffer | string): void {
    this.#buffer += chunk.toString();
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#handleLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #handleLine(line: string): void {
    let parsed: {
      id?: number;
      op?: string;
      ok?: boolean;
      result?: unknown;
      output?: unknown;
      error?: unknown;
      name?: unknown;
      args?: unknown;
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not a line we understand; the cell's own timeout will report it.
      return;
    }

    // Out-of-band: a cell asking the host to run a tool. It is blocked until we
    // answer, so answering is not optional.
    if (parsed.op === "tool_call" || parsed.op === "tool_calls") {
      void this.#answerToolCall(parsed);
      return;
    }

    if (typeof parsed.id !== "number") {
      this.#options.onNotice?.(line);
      return;
    }
    const resolve = this.#pending.get(parsed.id);
    if (!resolve) return;
    this.#pending.delete(parsed.id);
    resolve({
      ok: parsed.ok === true,
      result: (parsed.result ?? null) as string | null,
      output: typeof parsed.output === "string" ? parsed.output : "",
      error: typeof parsed.error === "string" ? parsed.error : undefined,
    });
  }

  async #answerToolCall(message: { op?: string; name?: unknown; args?: unknown; calls?: unknown }): Promise<void> {
    const write = (payload: Record<string, unknown>) => {
      try {
        this.#child?.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch {
        /* the kernel is gone; its next call will report that */
      }
    };

    if (message.op === "tool_calls") {
      const calls = Array.isArray(message.calls) ? message.calls : [];
      const results = await Promise.all(
        calls.map(async (call) => {
          const { name, args } = (call ?? {}) as { name?: string; args?: Record<string, unknown> };
          return this.#dispatchOne(String(name ?? ""), args ?? {});
        }),
      );
      write({ op: "tool_result", ok: true, results });
      return;
    }

    const outcome = await this.#dispatchOne(String(message.name ?? ""), (message.args as Record<string, unknown>) ?? {});
    write({ op: "tool_result", ...outcome });
  }

  async #dispatchOne(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#options.dispatch) {
      // Silence here would be the worst outcome: the cell waits for a reply
      // that never comes, and it looks exactly like a hung kernel.
      return { ok: false, error: `no tool dispatcher is attached, so '${name}' cannot run` };
    }
    try {
      return { ok: true, result: await this.#options.dispatch(name, args) };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
}

export interface InterpreterProbe {
  /** Resolves a command name to a path, or null. */
  which: (command: string) => string | null;
  /** Runs the interpreter with `-c` and returns its stdout, or null on failure. */
  probe: (path: string, script: string) => string | null;
  env?: Record<string, string | undefined>;
}

/**
 * Find an interpreter that actually runs.
 *
 * `python3` exists on Windows as a Store shim that produces nothing, so a
 * resolver that trusts `which` picks an interpreter that fails every cell. The
 * probe is one line of real execution, which is the only evidence that counts.
 */
export function resolveInterpreter(sources: InterpreterProbe): string | undefined {
  const env = sources.env ?? (process.env as Record<string, string | undefined>);
  const explicit = env.SEA_PYTHON?.trim() || env.MNEMO_PYTHON?.trim();
  if (explicit && sources.probe(explicit, "print(1)") === "1") return explicit;
  for (const candidate of ["python3", "python"]) {
    const path = sources.which(candidate);
    if (!path) continue;
    if (sources.probe(path, "print(1)") === "1") return path;
  }
  return undefined;
}

/** The real probe, used by the application. */
export function probeInterpreter(path: string, script: string): string | null {
  try {
    const result = spawnSync(path, ["-c", script], { encoding: "utf8", timeout: 10_000 });
    return result.status === 0 ? (result.stdout ?? "").trim() : null;
  } catch {
    return null;
  }
}

/** A spawn wrapper so a caller need not know about node's child_process shape. */
export function spawnKernel(interpreter: string, args: string[], cwd?: string): ChildProcess {
  return spawn(interpreter, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
}
