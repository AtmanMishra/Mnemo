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
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { textResult, type SeaTool } from "./types.ts";

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
  private readonly pythonBin: string;
  private readonly bridgePath: string;

  constructor(pythonBin?: string, bridgePath?: string) {
    this.pythonBin = pythonBin ?? (process.env.SEA_PYTHON || "python3");
    this.bridgePath = bridgePath ?? (process.env.SEA_IPY_BRIDGE || BRIDGE_PATH);
    // Never leak the interpreter into a parent that is shutting down.
    process.once("exit", () => this.stop());
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  private handleStdoutChunk(chunk: Buffer): void {
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
      const proc = spawn(this.pythonBin, ["-u", this.bridgePath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.stdout?.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
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
    "calls, exactly like notebook cells. Use restart=true to reset state.",
  parameters,
  async execute(_id, params) {
    if (params.restart) {
      await sharedKernel.restart();
    }
    const res = await sharedKernel.run(params.code, params.timeout_ms);
    if (!res.ok && res.error?.includes("timed out")) {
      throw new Error(res.error); // timeouts surface as tool errors per pi convention
    }
    return textResult(formatIpyResult(res), res as unknown as Record<string, unknown>);
  },
};
