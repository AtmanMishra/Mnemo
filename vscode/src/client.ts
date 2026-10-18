import { spawn, type ChildProcess } from "node:child_process";
import type { RpcEvent } from "./protocol";

/** Cut a byte stream into lines. A partial last line waits for its newline. */
export class LineSplitter {
  private rest = "";
  constructor(private readonly max = 16 * 1024 * 1024) {}

  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split("\n");
    this.rest = parts.pop() ?? "";
    if (this.rest.length > this.max) this.rest = "";
    return parts.map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
  }
}

export interface ClientOptions {
  command: string;
  args: string[];
  cwd: string;
  onEvent: (event: RpcEvent) => void;
  onExit: (code: number | null) => void;
  /** The program could not start (not installed, not executable), or wrote something that is not an event. */
  onProblem: (message: string) => void;
}

/**
 * `mnemo --rpc` as a child process. The program is started directly with an argument
 * list, never through a shell, and every line it writes is parsed as one event.
 */
export class MnemoClient {
  private child: ChildProcess | undefined;
  private seq = 0;
  private pending = new Map<number, (r: { ok: boolean; value?: unknown; error?: string }) => void>();

  constructor(private readonly o: ClientOptions) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  start(): void {
    if (this.running) return;
    const child = spawn(this.o.command, this.o.args, { cwd: this.o.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    const out = new LineSplitter();
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      for (const line of out.push(chunk)) this.line(line);
    });
    child.stderr!.setEncoding("utf8");
    let tail = "";
    child.stderr!.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-2000);
    });
    child.stdin!.on("error", () => {});
    child.on("error", (e) => {
      this.o.onProblem(`Could not start ${this.o.command}: ${e.message}`);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = undefined;
      for (const resolve of this.pending.values()) resolve({ ok: false, error: "Mnemo exited" });
      this.pending.clear();
      if (code) this.o.onProblem(tail.trim() || `Mnemo exited with code ${code}`);
      this.o.onExit(code);
    });
  }

  private line(text: string): void {
    let event: RpcEvent;
    try {
      event = JSON.parse(text);
    } catch {
      return void this.o.onProblem(`unexpected output from mnemo: ${text.slice(0, 200)}`);
    }
    if (event.type === "result") {
      const resolve = this.pending.get(event.id);
      if (resolve) {
        this.pending.delete(event.id);
        resolve(event);
      }
    }
    this.o.onEvent(event);
  }

  /** Fire and forget. Returns false when the program is not running. */
  send(message: Record<string, unknown>): boolean {
    if (!this.running || !this.child?.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  /** A command that answers with a `result` event. */
  request(message: Record<string, unknown>, timeoutMs = 15000): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "timed out" });
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      if (!this.send({ ...message, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: "Mnemo is not running" });
      }
    });
  }

  /** Ask it to quit; kill it if it does not. Open dialogs resolve as "no" on the way out. */
  stop(): void {
    const child = this.child;
    if (!child) return;
    this.send({ type: "quit" });
    child.stdin?.end();
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 2000).unref();
  }
}
