/**
 * The smallest language-server client that can answer one question: what does the server
 * think is wrong with this file after it changed? It speaks JSON-RPC over the server's stdio,
 * keeps the files it has shown the server open, and waits for the server to publish diagnostics.
 *
 * Servers push diagnostics when they are ready (a syntax pass, then a type pass), so a result
 * is the last publish that arrives within `settleMs` of the previous one, and nothing at all
 * (undefined) when none arrives before the deadline. A server that dies fails the client for good.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface Diagnostic {
  /** 1-based. */
  line: number;
  column: number;
  /** LSP severity: 1 error, 2 warning, 3 information, 4 hint. */
  severity: number;
  message: string;
  code?: string;
  source?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Published {
  version?: number;
  list: Diagnostic[];
}

type Json = Record<string, unknown>;

export interface ClientOptions {
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Milliseconds to wait for `initialize`. */
  startMs?: number;
  /** Milliseconds of quiet after a publish before it is taken as final. */
  settleMs?: number;
}

export class LspClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private published = new Map<string, Published>();
  private waiters = new Set<() => void>();
  private versions = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private settleMs: number;
  /** Why the server is gone, once it is. */
  dead?: string;

  private constructor(private opts: ClientOptions) {
    this.settleMs = opts.settleMs ?? 250;
    this.child = spawn(opts.command[0]!, opts.command.slice(1), { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    // A server's own log is not the model's business; draining it keeps the pipe from filling.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => {});
    this.child.on("error", (e) => this.fail(e.message));
    this.child.on("close", (code) => this.fail(`exited with ${code}`));
  }

  static async start(opts: ClientOptions): Promise<LspClient> {
    const client = new LspClient(opts);
    try {
      const root = pathToFileURL(opts.cwd).href;
      await client.request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "mnemo" },
          rootUri: root,
          workspaceFolders: [{ uri: root, name: "workspace" }],
          capabilities: {
            textDocument: { publishDiagnostics: { versionSupport: true }, synchronization: { didSave: false } },
            workspace: { configuration: true, workspaceFolders: true },
          },
        },
        opts.startMs ?? 20_000,
      );
      client.notify("initialized", {});
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  private fail(why: string): void {
    if (this.dead) return;
    this.dead = why;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`the language server ${why}`));
    }
    this.pending.clear();
    for (const wake of this.waiters) wake();
  }

  private send(message: Json): void {
    if (this.dead) return;
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params: params as Json });
  }

  private request(method: string, params: unknown, ms: number): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(`the language server ${this.dead}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the language server did not answer ${method} within ${Math.round(ms / 1000)}s`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params: params as Json });
    });
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString("ascii"))?.[1];
      if (!length) {
        // Not a frame we can place: the stream cannot be trusted past this point.
        this.fail("sent a message without a Content-Length");
        this.child.kill();
        return;
      }
      const start = end + 4;
      if (this.buffer.length < start + Number(length)) return;
      const body = this.buffer.subarray(start, start + Number(length)).toString("utf8");
      this.buffer = this.buffer.subarray(start + Number(length));
      let message: Json;
      try {
        message = JSON.parse(body) as Json;
      } catch {
        continue;
      }
      this.handle(message);
    }
  }

  private handle(m: Json): void {
    const method = typeof m.method === "string" ? m.method : undefined;
    if (method === undefined) {
      const p = this.pending.get(m.id as number);
      if (!p) return;
      this.pending.delete(m.id as number);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String((m.error as Json).message ?? "the language server answered with an error")));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined) {
      // A request from the server: answer so it never waits on us, with nothing configured and nothing applied.
      const params = (m.params ?? {}) as Json;
      const result =
        method === "workspace/configuration" ? ((params.items as unknown[]) ?? []).map(() => null) : method === "workspace/applyEdit" ? { applied: false } : method === "workspace/workspaceFolders" ? [] : null;
      this.send({ id: m.id as number, result: result as never });
      return;
    }
    if (method === "textDocument/publishDiagnostics") {
      const params = m.params as { uri: string; version?: number; diagnostics?: Json[] };
      this.published.set(params.uri, { version: params.version, list: (params.diagnostics ?? []).map(toDiagnostic) });
      for (const wake of this.waiters) wake();
    }
  }

  /**
   * What the server reports for `file` with this `text`. Calls are served one at a time, in order.
   * Undefined when the server reported nothing before `waitMs` ran out or when it is gone.
   */
  diagnose(file: string, text: string, languageId: string, waitMs: number): Promise<Diagnostic[] | undefined> {
    const run = this.chain.then(() => this.diagnoseNow(file, text, languageId, waitMs));
    this.chain = run.catch(() => {});
    return run;
  }

  private async diagnoseNow(file: string, text: string, languageId: string, waitMs: number): Promise<Diagnostic[] | undefined> {
    if (this.dead) return undefined;
    const uri = pathToFileURL(file).href;
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.published.delete(uri);
    if (version === 1) this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    else this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    this.versions.set(uri, version);

    const deadline = Date.now() + waitMs;
    let seen: Published | undefined;
    let quietSince = 0;
    // A publish counts when it is for this version, or names none.
    const current = () => {
      const p = this.published.get(uri);
      return p && (p.version === undefined || p.version >= version) ? p : undefined;
    };
    while (!this.dead) {
      const now = Date.now();
      const p = current();
      if (p !== seen) {
        seen = p;
        quietSince = now;
      }
      if (seen && now - quietSince >= this.settleMs) return seen.list;
      if (now >= deadline) return seen?.list;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(50, Math.max(1, deadline - now)));
        this.waiters.add(wake);
      });
    }
    return seen?.list;
  }

  /** Ask the server to stop, then make sure it has. */
  async close(): Promise<void> {
    if (!this.dead) {
      await this.request("shutdown", null, 1000).catch(() => {});
      this.notify("exit", null);
    }
    const child = this.child;
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 1000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.fail("was closed");
  }
}

function toDiagnostic(d: Json): Diagnostic {
  const start = ((d.range as Json | undefined)?.start ?? {}) as { line?: number; character?: number };
  return {
    line: (start.line ?? 0) + 1,
    column: (start.character ?? 0) + 1,
    severity: typeof d.severity === "number" ? d.severity : 1,
    message: String(d.message ?? ""),
    code: d.code === undefined ? undefined : String(typeof d.code === "object" && d.code !== null ? (d.code as Json).value : d.code),
    source: typeof d.source === "string" ? d.source : undefined,
  };
}
