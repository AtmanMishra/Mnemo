/**
 * ipy_run: persistent Python execution over a JSON-lines stdio bridge.
 *
 * One long-lived `python3` subprocess runs kernel/ipy_bridge.py. Every call is
 * a {id, code} request answered by an {id, ok, result|error, output} response,
 * so state (variables, imports, functions) persists across tool calls like a
 * notebook kernel. Calls are serialized through a promise chain, so multiple
 * pending calls execute strictly in submission order.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { textResult, type SeaTool, type ToolContext } from "./types.ts";
import { childShellEnv, sessionEnvFromContext, type PiSessionEnv } from "../childenv.ts";
import { resolvePythonBin } from "../python.ts";

const BRIDGE_PATH = fileURLToPath(new URL("../../kernel/ipy_bridge.py", import.meta.url));

export interface IpyResult {
  ok: boolean;
  /** repr() of the last expression's value, when present and non-None. */
  result?: string | null;
  /** Captured stdout + stderr produced by the cell. */
  output?: string;
  /** Traceback text when ok is false. */
  error?: string;
}

interface Pending {
  resolve: (value: IpyResult) => void;
}

/**
 * 4.6: how a `tools.<name>(...)` call from inside the kernel reaches the host.
 * Returns whatever should become the Python return value.
 *
 * The optional signal is issue #6(a)'s other half: when the per-call timeout
 * expires, the host aborts this call so tools that honour cancellation (e.g.
 * bash_exec) stop their work instead of running on after the reply.
 */
export type ToolDispatcher = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * How many in-kernel tool calls may execute at once. Approval prompting is
 * serialized separately (see makeKernelDispatcher); this bounds the work.
 */
export const MAX_PARALLEL_TOOL_CALLS = 8;

/**
 * Issue #6(a): the per-call bound on ONE `tools.<name>(...)` call made from
 * inside the kernel. Without it a tool that never returns holds the kernel in
 * readline() until the PROGRAM timeout kills it — a dead cell and a lost
 * namespace, not an error the program can see. This bound is deliberately
 * shorter than the program timeout (default 120000) so the call fails first
 * and the program still has budget to catch the ToolError and finish.
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/** Env override for the per-call bound; the legacy SEA_* name still works. */
export const TOOL_CALL_TIMEOUT_ENV = "MNEMO_KERNEL_TOOL_TIMEOUT_MS";
const LEGACY_TOOL_CALL_TIMEOUT_ENV = "SEA_KERNEL_TOOL_TIMEOUT_MS";

/** A positive-integer env value, or the fallback when unset/unreadable/zero. */
function positiveEnvInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The per-call tool timeout in force for a new kernel: the env override when
 * it is a positive number, else DEFAULT_TOOL_CALL_TIMEOUT_MS. There is no
 * "off": the point of the bound is that a hung tool is catchable, and the
 * program timeout remains the ceiling either way.
 */
export function resolveToolCallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveEnvInt(
    env[TOOL_CALL_TIMEOUT_ENV] ?? env[LEGACY_TOOL_CALL_TIMEOUT_ENV],
    DEFAULT_TOOL_CALL_TIMEOUT_MS,
  );
}

/**
 * Issue #11(b): the resource caps the kernel applies to ITSELF at startup.
 * POSIX has rlimits (RLIMIT_AS / RLIMIT_CPU); Windows has no such facility,
 * and the bridge says so rather than pretending. The host resolves the policy
 * here and passes it down as env, so the numbers exist in one place and the
 * tool description can state exactly what is (or is not) in force.
 */
export const KERNEL_MEMORY_ENV = "MNEMO_KERNEL_MEMORY_MB";
export const KERNEL_CPU_ENV = "MNEMO_KERNEL_CPU_SECONDS";
/** Address space offered to the kernel, in MiB. 0 lifts the cap. */
export const DEFAULT_KERNEL_MEMORY_MB = 2048;
/** Total CPU time offered to the kernel, in seconds. 0 lifts the cap. */
export const DEFAULT_KERNEL_CPU_SECONDS = 1800;

export interface KernelLimits {
  /** Address-space cap in MiB; undefined means "no cap". */
  memoryMb?: number | undefined;
  /** Total CPU-seconds cap; undefined means "no cap". */
  cpuSeconds?: number | undefined;
}

/** Unset -> default; a plain 0 -> no cap (only an explicit opt-out); unreadable -> default. */
function resolveCap(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return fallback;
  if (n === 0) return undefined;
  return n > 0 ? Math.floor(n) : fallback;
}

/** Resolve the kernel caps for a spawn. Read once per kernel, like the env it comes from. */
export function resolveKernelLimits(env: NodeJS.ProcessEnv = process.env): KernelLimits {
  return {
    memoryMb: resolveCap(env[KERNEL_MEMORY_ENV], DEFAULT_KERNEL_MEMORY_MB),
    cpuSeconds: resolveCap(env[KERNEL_CPU_ENV], DEFAULT_KERNEL_CPU_SECONDS),
  };
}

/** What the bridge reads to apply the caps; an explicit 0 means "none asked for". */
export function kernelLimitEnv(limits: KernelLimits): Record<string, string> {
  return {
    [KERNEL_MEMORY_ENV]: String(limits.memoryMb ?? 0),
    [KERNEL_CPU_ENV]: String(limits.cpuSeconds ?? 0),
  };
}

function drainPending(pending: Map<number, Pending>, value: IpyResult): void {
  const entries = [...pending.entries()];
  pending.clear();
  for (const [, p] of entries) p.resolve(value);
}


export class IPyKernel {
  private proc: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private queue: Promise<unknown> = Promise.resolve();
  private stderrTail: string[] = [];
  private dispatcher: ToolDispatcher | null = null;
  /** Empty until the first spawn, which resolves it (python.ts). */
  private pythonBin: string;
  private readonly bridgePath: string;
  private readonly spawnImpl: typeof spawn;
  /** 6(a): default per-call bound; one cell can override it via run(). */
  private readonly toolCallTimeoutMs: number;
  /** 6(a): the bound in force for the cell currently running (cells serialize). */
  private cellToolTimeoutMs: number;
  /** 11(b): resolved once and handed to the interpreter as spawn env. */
  private readonly limits: KernelLimits;
  /** Session facts the interpreter's environment publishes (D6). */
  private session: PiSessionEnv | undefined;

  constructor(
    pythonBin?: string,
    bridgePath?: string,
    spawnImpl: typeof spawn = spawn,
    toolCallTimeoutMs: number = resolveToolCallTimeoutMs(),
    limits: KernelLimits = resolveKernelLimits(),
  ) {
    this.pythonBin = pythonBin ?? (process.env.SEA_PYTHON || "");
    this.bridgePath = bridgePath ?? (process.env.SEA_IPY_BRIDGE || BRIDGE_PATH);
    this.spawnImpl = spawnImpl;
    this.toolCallTimeoutMs = toolCallTimeoutMs > 0 ? toolCallTimeoutMs : DEFAULT_TOOL_CALL_TIMEOUT_MS;
    this.cellToolTimeoutMs = this.toolCallTimeoutMs;
    this.limits = limits;
    // Never leak the interpreter into a parent that is shutting down.
    process.once("exit", () => this.stop());
  }

  /**
   * Publish the live session's PI_* values (D6). Resolved from the tool's
   * per-call context; the interpreter respawns with the latest values, and a
   * cell that inspects os.environ sees them from then on.
   */
  setSessionEnv(session: PiSessionEnv | undefined): void {
    this.session = session;
  }

  /** What a child spawned from an in-kernel tool call should inherit (D6). */
  toolContext(): ToolContext | undefined {
    return this.session ? { sessionEnv: this.session } : undefined;
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /**
   * Make host tools callable from submitted code as `tools.<name>(...)`.
   * Without this the kernel has no `tools` object and code that reaches for
   * one gets a plain NameError.
   */
  setToolDispatcher(fn: ToolDispatcher | null): void {
    this.dispatcher = fn;
  }

  /**
   * Answer one in-kernel tool call. This ALWAYS writes a reply, including on
   * failure: the kernel is blocked on readline() and a missing reply would
   * deadlock it for the rest of the session.
   *
   * Issue #6(a): every call is bounded by the cell's per-call timeout, so a
   * tool that never returns becomes a ToolError inside the program instead of
   * a dead cell. Exactly ONE reply is written, here, after every call in the
   * message has settled — the kernel matches replies to calls POSITIONALLY
   * (they carry no ids), so a late second write would be read as the answer
   * to the NEXT call and desync the protocol for the rest of the session.
   */
  private async serveToolCall(msg: any, proc: ChildProcess): Promise<void> {
    const timeoutMs = this.cellToolTimeoutMs;
    let reply: Record<string, unknown>;
    try {
      if (!this.dispatcher) throw new Error("no tools are available inside this kernel");
      if (msg?.op === "tool_calls") {
        reply = { op: "tool_result", ok: true, results: await this.runBatch(msg?.calls, timeoutMs) };
      } else {
        const name = String(msg?.name ?? "");
        const args = (msg?.args ?? {}) as Record<string, unknown>;
        const outcome = await this.runToolCall(name, args, timeoutMs);
        reply = outcome.ok
          ? { op: "tool_result", ok: true, result: outcome.result }
          : { op: "tool_result", ok: false, error: outcome.error };
      }
    } catch (err: any) {
      reply = { op: "tool_result", ok: false, error: String(err?.message ?? err) };
    }
    this.writeReply(proc, reply);
  }

  /**
   * One host tool call, bounded (issue #6(a)). Resolves with the reply
   * payload; a throw and a timeout both come back as {ok:false, error}, never
   * as a rejection, so a caller cannot accidentally skip the reply.
   *
   * On timeout the call is aborted: tools that watch their signal — bash_exec
   * does — stop their work right there. A tool that ignores it keeps running
   * on the host, but its eventual result is DROPPED, because the reply the
   * kernel already has is this timeout and a second one would desync it.
   */
  private async runToolCall(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(
          `tool "${name}" did not return within ${timeoutMs}ms (per-call time limit) and was cut loose; ` +
            `the kernel continues. Raise tool_timeout_ms on ipy_run (or ${TOOL_CALL_TIMEOUT_ENV}) ` +
            `if the call legitimately needs longer.`,
        ));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([this.dispatcher!(name, args, controller.signal), expired]);
      return { ok: true, result };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Write one reply, and only while the kernel that asked is still the kernel
   * on the other end.
   *
   * Both halves matter for "the protocol still recovers" (#6(a)): the calls
   * carry no ids — the kernel reads replies positionally, one per call — so a
   * reply written after the kernel was killed, restarted or replaced would sit
   * in the NEXT kernel's stdin and be read as the answer to some future call.
   * The two sides would then stay one reply out of phase for the whole
   * session. A tool that settles after its timeout must write nothing at all.
   */
  private writeReply(proc: ChildProcess, reply: Record<string, unknown>): void {
    if (this.proc !== proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      proc.stdin?.write(JSON.stringify(reply) + "\n");
    } catch { /* died between the check and the write; the next run() respawns it */ }
  }

  /**
   * Run a batch of in-kernel tool calls concurrently, in bounded waves.
   *
   * The point of a batch is that N calls cost one round trip instead of N, so
   * they run at the same time - but not ALL at the same time: a hundred
   * parallel bash_exec calls would be a fork bomb wearing a tool name.
   * Failures come back in place rather than rejecting the batch, and so do
   * per-call timeouts (#6(a)): each element is bounded on its own, so one hung
   * tool cannot hold the other seven past its own timeout.
   */
  private async runBatch(calls: unknown, timeoutMs: number): Promise<Array<Record<string, unknown>>> {
    if (!Array.isArray(calls)) throw new Error("tool_calls: calls must be an array");
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < calls.length; i += MAX_PARALLEL_TOOL_CALLS) {
      const wave = calls.slice(i, i + MAX_PARALLEL_TOOL_CALLS);
      out.push(...await Promise.all(wave.map(async (c: any) => {
        const name = String(c?.name ?? "");
        const args = (c?.args ?? {}) as Record<string, unknown>;
        return await this.runToolCall(name, args, timeoutMs);
      })));
    }
    return out;
  }

  private handleStdoutChunk(chunk: Buffer, proc: ChildProcess): void {
    this.buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a protocol line; ignore
      }
      if (msg.op === "tool_call" || msg.op === "tool_calls") {
        // The process matters: a reply written to a kernel that has since been
        // killed and respawned would be read as the answer to whatever call
        // comes next (writeReply drops it when this.proc has moved on).
        void this.serveToolCall(msg, proc);
        continue;
      }
      if (msg.id === 0) {
        // Response to the startup ping handshake.
        if (msg.ok) this.ponged = true;
        return;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve({
          ok: Boolean(msg.ok),
          result: msg.result ?? null,
          output: msg.output ?? "",
          error: msg.error ?? undefined,
        });
      }
    }
  }

  async start(): Promise<void> {
    if (this.alive) return;
    this.starting ||= new Promise<void>((resolve, reject) => {
      // A stale pong from a previous kernel must not fake the handshake.
      this.ponged = false;
      // Which interpreter: an explicit one wins, then SEA_PYTHON, then the
      // first candidate that actually runs (issue #1: `python3` is the POSIX
      // name, and on Windows a bare python3 on PATH is very often the
      // Microsoft Store alias stub that exits 9009 with "Python was not
      // found"). Resolution failing throws here, inside the spawn's own
      // error path, so the user gets "no python 3 interpreter found (tried
      // py, python, python3) — install one or set SEA_PYTHON" rather than an
      // opaque ENOENT.
      if (!this.pythonBin) this.pythonBin = resolvePythonBin();
      const proc = this.spawnImpl(this.pythonBin, ["-u", this.bridgePath], {
        stdio: ["pipe", "pipe", "pipe"],
        // 12.7 + D6: credentials out, stale inherited PI_* out, this
        // session's PI_* in — a Python cell sees the same session variables
        // pi's own shell tools would publish.
        env: childShellEnv(this.session),
      });
      proc.stdout?.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk, proc));
      proc.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail.push(chunk.toString("utf8"));
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      });
      const onExit = () => {
        // Fail anything still pending; the next run() respawns a fresh kernel.
        // Only clear if this child is still the current one - a killed kernel's
        // exit event can otherwise clobber a freshly respawned process.
        if (this.proc === proc) this.proc = null;
        drainPending(this.pending, { ok: false, error: "kernel exited before responding", output: "" });
      };
      proc.once("exit", onExit);
      proc.once("error", (err) => {
        this.proc = null;
        reject(err);
      });

      // Health-check handshake confirms the bridge speaks our protocol.
      proc.stdin?.write(JSON.stringify({ id: 0, op: "ping" }) + "\n");
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`ipy kernel ping timed out (python: ${this.pythonBin})`));
      }, 10_000);
      const check = setInterval(() => {
        if (this.ponged) {
          cleanup();
          resolve();
        } else if (!this.alive) {
          cleanup();
          reject(new Error(`ipy kernel died during startup:\n${this.stderrTail.join("")}`));
        }
      }, 25);

      function cleanup() {
        clearTimeout(timeout);
        clearInterval(check);
      }

      this.proc = proc;
    });
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private ponged = false;

  /** Execute code. Concurrent callers are queued; execution order == call order. */
  run(code: string, timeoutMs: number = 120_000): Promise<IpyResult> {
    const task = this.queue.then(async () => {
      await this.start();
      return await this.runImmediate(code, timeoutMs);
    });
    // Swallow rejections on the chain itself so one failed cell doesn't poison the queue.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private runImmediate(code: string, timeoutMs: number): Promise<IpyResult> {
    const id = this.nextId++;
    const proc = this.proc;
    const stdin = proc?.stdin ?? null;
    if (!proc || !stdin || proc.exitCode !== null) {
      // Kernel vanished between queueing and execution; force a respawn next call.
      this.proc = null;
      return Promise.resolve({
        ok: false,
        error: "ipy_run: kernel is not running; retry the call to restart it.",
        output: "",
      });
    }
    return new Promise<IpyResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A hung cell means unknown kernel state: kill it and drop it right away
        // so the next run() respawns a fresh kernel instead of writing into a
        // dying process (kill-and-respawn fallback per spec).
        if (this.proc === proc) this.proc = null;
        try { proc.removeAllListeners("exit"); } catch { /* ignore */ }
        proc.once("exit", () => drainPending(this.pending, { ok: false, error: "kernel exited before responding", output: "" }));
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        resolve({
          ok: false,
          error:
            `ipy_run: timed out after ${timeoutMs}ms; kernel was killed and will restart on the next call.`,
          output: "",
        });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      try {
        stdin.write(JSON.stringify({ id, op: "run", code }) + "\n");
      } catch {
        this.pending.delete(id);
        if (this.proc === proc) this.proc = null;
        resolve({ ok: false, error: "ipy_run: kernel stdin closed; the kernel will restart on the next call.", output: "" });
      }
    });
  }

  /** Kill the interpreter and start a clean one. All prior state is lost. */
  async restart(): Promise<void> {
    const old = this.proc;
    this.proc = null;
    this.ponged = false;
    this.buffer = "";
    drainPending(this.pending, { ok: false, error: "kernel restarted while call was pending", output: "" });
    if (old && old.exitCode === null) {
      old.removeAllListeners("exit");
      old.kill("SIGKILL");
    }
    await this.start();
  }

  stop(): void {
    const old = this.proc;
    this.proc = null;
    if (old && old.exitCode === null) {
      old.removeAllListeners("exit");
      old.kill("SIGKILL");
    }
    this.pending.clear();
  }
}

/** Process-wide shared kernel so every ipy_run call hits the same namespace. */
export const sharedKernel = new IPyKernel();

const parameters = Type.Object({
  code: Type.String({ description: "Python source to execute in the persistent kernel." }),
  restart: Type.Optional(
    Type.Boolean({ description: "Restart the kernel first, discarding all previous state. Default false." }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({ description: "Kill a hung cell after this many milliseconds. Default 120000.", minimum: 1 }),
  ),
});

function formatIpyResult(res: IpyResult): string {
  const parts: string[] = [];
  if (res.output) parts.push(res.output.replace(/\n$/, ""));
  if (res.ok) {
    if (res.result != null) parts.push(`=> ${res.result}`);
  } else {
    parts.push(res.error ?? "(unknown error)");
  }
  return parts.join("\n") || "(no output)";
}

export const ipyRunTool: SeaTool = {
  name: "ipy_run",
  label: "IPython run",
  description:
    "Execute Python in ONE persistent kernel process. Variables, imports and functions persist across " +
    "calls, exactly like notebook cells. Use restart=true to reset state.\n" +
    "Host tools are callable from the code as `tools.<name>(arg=...)`, returning the tool's text. " +
    "A refused or failed tool raises ToolError, which you can catch. Prefer this whenever you would " +
    "otherwise issue many similar tool calls: a loop over forty files is one ipy_run call, not forty.\n" +
    "`tools.parallel([(name, {args}), ...])` runs a whole batch at once and returns the results in " +
    "order; a failed element is a ToolError in the list instead of the result, so the rest survive. " +
    "Use it whenever the calls do not depend on each other.",
  parameters,
  async execute(_id, params, _signal, _onUpdate, ctx) {
    // D6: resolve the session environment per call, so a kernel restarted mid
    // session (or the first start after this call) sees the live values.
    sharedKernel.setSessionEnv(sessionEnvFromContext(ctx));
    if (params.restart) {
      await sharedKernel.restart();
    }
    const res = await sharedKernel.run(params.code, params.timeout_ms);
    if (!res.ok && res.error?.includes("timed out")) {
      throw new Error(res.error); // timeouts surface as tool errors per pi convention
    }
    // SAFETY: `res` is the kernel's JSON result payload — its fields are
    // already plain JSON (ok/error/output/result), so it is structurally
    // compatible with pi's `details` object; we assert only the shape pi
    // requires, never a truth the kernel didn't produce.
    return textResult(formatIpyResult(res), res as unknown as Record<string, unknown>);
  },
};
