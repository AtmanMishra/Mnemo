/**
 * The Rust side, behind a client of ours.
 *
 * `memsrv` is a process that speaks JSON lines: one request per line
 * (`{"id":1,"method":"search","params":{…}}`), one response per line
 * (`{"id":1,"ok":true,"result":{…}}`). It owns the journal, the graph of facts
 * and episodes, and consolidation; the application owns everything else.
 *
 * Three things here are not incidental — each one is a failure the older code
 * had already met:
 *
 *  1. **Requests are serialized.** The protocol is request/response on one pipe,
 *     so two in flight interleave and a reply can be read against the wrong
 *     request. A queue is cheaper than a correlation bug hunt.
 *  2. **Chunks are not lines.** A single `data` event can carry half a JSON
 *     object, or three of them; the buffer keeps the remainder. Parsing per
 *     chunk works until a large search result arrives, and then it does not.
 *  3. **A dead sidecar is not an exception.** Memory is a feature, and a feature
 *     that is offline must degrade: every call answers `{ ok: false, error }`
 *     and the session keeps going. The old code learned this the hard way — a
 *     sidecar that could not be spawned took the whole session with it.
 */
import type { ChildProcess } from "node:child_process";

export interface MemoryResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** The slice of a child process this client uses, so a test can be a plain object. */
export interface MemoryChild {
  stdin: { write(chunk: string): unknown } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): unknown;
  exitCode: number | null;
  signalCode?: string | null;
}

export type MemorySpawn = (binary: string, args: string[]) => MemoryChild;

export interface MemoryClientOptions {
  binaryPath: string;
  journalPath: string;
  spawn: MemorySpawn;
  /** How long to wait for a reply before answering `{ ok: false }`. */
  timeoutMs?: number;
  /** How long a stopped sidecar may live before it is killed. */
  killGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_GRACE_MS = 250;

export class MemoryClient {
  #child: MemoryChild | null = null;
  #nextId = 1;
  #buffer = "";
  #pending = new Map<number, (response: MemoryResponse) => void>();
  /** Every request runs after the previous one settles. */
  #queue: Promise<unknown> = Promise.resolve();
  #readonly: MemoryClientOptions;

  constructor(options: MemoryClientOptions) {
    this.#readonly = options;
  }

  get alive(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  get journal(): string {
    return this.#readonly.journalPath;
  }

  get binary(): string {
    return this.#readonly.binaryPath;
  }

  /** Send one request. Never throws: a transport failure is a response too. */
  request(method: string, params: Record<string, unknown> = {}): Promise<MemoryResponse> {
    const task = this.#queue.then(async () => {
      try {
        this.#start();
      } catch (error) {
        return { ok: false, error: `memory sidecar unavailable: ${String(error)}` } as MemoryResponse;
      }
      return this.#send(method, params);
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }

  /** Ask it to exit, then insist. Timers are unref'd so a client cannot hold a process open. */
  stop(): void {
    const child = this.#child;
    this.#child = null;
    for (const [, resolve] of this.#pending) resolve({ ok: false, error: "client stopped" });
    this.#pending.clear();
    if (!child) return;
    try {
      child.stdin?.write(`${JSON.stringify({ method: "exit" })}\n`);
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, this.#readonly.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  #start(): void {
    if (this.alive) return;
    const child = this.#readonly.spawn(this.#readonly.binaryPath, [this.#readonly.journalPath]);
    child.stdout?.on("data", (chunk) => this.#ingest(chunk));
    child.on("exit", () => {
      // Only the current child's death is about the current requests: a
      // replaced sidecar's exit arrives after its replacement is serving, and
      // resolving the new one's calls with the old one's death is a lie about
      // the wrong process. (Found in the kernel client, fixed in both — the
      // shape is identical, so the bug was too.)
      if (this.#child !== child) return;
      for (const [, resolve] of this.#pending) {
        resolve({ ok: false, error: "memory sidecar exited" });
      }
      this.#pending.clear();
      this.#child = null;
    });
    child.on("error", (error) => {
      if (this.#child !== child) return;
      for (const [, resolve] of this.#pending) {
        resolve({ ok: false, error: `memory sidecar error: ${String(error)}` });
      }
      this.#pending.clear();
    });
    this.#child = child;
  }

  #send(method: string, params: Record<string, unknown>): Promise<MemoryResponse> {
    const child = this.#child;
    if (!child?.stdin) return Promise.resolve({ ok: false, error: "memory sidecar has no stdin" });
    const id = this.#nextId++;
    const timeoutMs = this.#readonly.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<MemoryResponse>((resolve) => {
      // Deliberately NOT unref'd. This timer is the promise's only guarantee
      // that it ever settles, so it is allowed to hold the loop open — an
      // "unref'd everything" reflex here meant a sidecar that never answered
      // left the caller waiting forever, which is the exact failure the timer
      // exists to prevent. Only cleanup timers are unref'd (see `stop`).
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, error: `memory sidecar did not answer ${method} within ${timeoutMs}ms` });
      }, timeoutMs);

      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });

      try {
        child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve({ ok: false, error: `could not write to memory sidecar: ${String(error)}` });
      }
    });
  }

  /** Accumulate, then take whole lines. The remainder stays for the next chunk. */
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
    let parsed: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not ours to interpret; a sidecar writing something unparseable is a
      // sidecar problem, and the caller's timeout will report it.
      return;
    }
    if (typeof parsed.id !== "number") return;
    const resolve = this.#pending.get(parsed.id);
    if (!resolve) return;
    this.#pending.delete(parsed.id);
    resolve({ ok: parsed.ok === true, result: parsed.result, error: parsed.error });
  }
}
