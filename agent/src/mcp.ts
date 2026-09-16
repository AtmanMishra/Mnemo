/**
 * 4.1 MCP client bridge: MCP servers become ordinary Mnemo tools.
 *
 * MCP's stdio transport is line-delimited JSON-RPC 2.0 — the same shape as
 * memsrv and the ipy kernel bridge, both already in this repo — so this speaks
 * it directly rather than pulling in the MCP SDK and its dependency tree.
 * Implemented: initialize, tools/list, tools/call. That is the whole surface a
 * tool bridge needs; resources and prompts can follow if something wants them.
 *
 * Config lives in ~/.mnemo/mcp.json:
 *   { "servers": { "graft": { "command": "uvx", "args": ["graft-mcp"] } } }
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { textResult, type ImageContent, type SeaTool, type ToolResult } from "./tools/types.ts";
import { scrubChildEnv } from "./childenv.ts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Skip this server without deleting its entry. */
  disabled?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export const EMPTY_CONFIG: McpConfig = { servers: {} };

export function mcpConfigFile(home = os.homedir()): string {
  return path.join(home, ".mnemo", "mcp.json");
}

/** A missing or broken config means "no MCP servers", never a crash. */
export function loadMcpConfig(home = os.homedir()): McpConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpConfigFile(home), "utf8"));
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(raw?.servers ?? {})) {
      const c = cfg as any;
      if (typeof c?.command !== "string" || !c.command) continue;
      servers[name] = {
        command: c.command,
        args: Array.isArray(c.args) ? c.args.map(String) : [],
        env: typeof c.env === "object" && c.env ? c.env : {},
        disabled: Boolean(c.disabled),
      };
    }
    return { servers };
  } catch {
    return EMPTY_CONFIG;
  }
}

/** Tool names are namespaced so two servers can both expose a "search". */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

// --- 11(a): tear down the server TREE, never orphan it ---------------------
//
// An MCP server is a tree, not a process. `spawn("uvx", ["graft-mcp"])` is a
// launcher: the server itself is a python grandchild, so SIGTERM to the pid we
// hold reaches the launcher only — the server keeps running (and keeps the
// stdout pipe open, so anything waiting on that pipe waits forever) after the
// agent that started it is gone.
//
// Teardown is therefore two-phase, per platform:
//   POSIX   — SIGTERM to the whole process GROUP, SIGKILL after a grace
//             period. Group delivery needs the server to lead its own group,
//             which is what spawn({ detached: true }) buys (see start()).
//   Windows — `taskkill /PID <pid> /T`, escalating to `taskkill /PID <pid> /T
//             /F`. There is no signal to send, and proc.kill() is
//             TerminateProcess on the direct child only — the children of an
//             MCP launcher are exactly what survives it.
//
// The report keeps the two outcomes apart: a tree that ended on the graceful
// signal died quietly; one that needed force is reported (defaultTermination
// Reporter writes it to stderr), so a server that would have been orphaned is
// visible in the run's output instead of silent.

/** Grace a server gets to exit on the graceful signal before force, ms. */
export const MCP_TERMINATE_GRACE_MS = 2_000;

/**
 * The slice of child_process.ChildProcess this client drives. Structural, so a
 * test can hand it a fake process object and no server is ever launched.
 * `exitCode`/`signalCode` are `null` while the process runs, as in node.
 */
export interface McpProcess {
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdin?: { write(chunk: string): unknown; end(): unknown } | null;
  stdout?: { on(event: "data", listener: (chunk: any) => void): unknown; destroy?(): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: any) => void): unknown; destroy?(): unknown } | null;
  once(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** What terminateTree needs to know about one process. */
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
    // Negative pid = the process GROUP. Only correct because start() spawns
    // POSIX servers detached, which makes the server its own group leader.
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

/** What happened when one server tree was taken down. */
export interface TerminationReport {
  /** The server this report is about, so a log line can name it. */
  server: string;
  /**
   * True when the tree did NOT end on the graceful signal and had to be
   * forced — i.e. this server would have been orphaned before 11(a).
   */
  escalated: boolean;
  /**
   * The action that ended (or was last used on) the tree: "SIGTERM",
   * "SIGKILL", "taskkill /T", "taskkill /T /F", or "none" when there was
   * nothing left to signal.
   */
  method: string;
  /** Grace the server was given before force, ms. */
  graceMs: number;
  /** The tree leader's pid, when it had one. */
  pid?: number | undefined;
  /** Why even the forced action could not be delivered, when it could not. */
  error?: string | undefined;
}

/**
 * End one server tree, gracefully then forcefully, and report which it took.
 * Always resolves — a wedged server must not be able to hang the caller — and
 * never rejects, so callers can fire it and forget it. Resolves once the tree
 * is gone (graceful exit observed) or once the forced action has been
 * delivered, whichever happens first.
 */
export function terminateTree(
  target: TearDownTarget,
  server: string,
  opts: { graceMs?: number; kill?: KillSystem } = {},
): Promise<TerminationReport> {
  const kill = opts.kill ?? DEFAULT_KILL_SYSTEM;
  const graceMs = opts.graceMs ?? MCP_TERMINATE_GRACE_MS;
  const win = kill.platform === "win32";
  const gracefulAction = win ? "taskkill /T" : "SIGTERM";
  const forcedAction = win ? "taskkill /T /F" : "SIGKILL";
  const pid = target.pid;

  // Nothing to take down: the spawn never produced a pid (an 'error' event), or
  // the process is already gone.
  if (pid === undefined || !target.alive()) {
    return Promise.resolve<TerminationReport>({ server, escalated: false, method: "none", graceMs, pid });
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
    } catch (err: any) {
      error = String(err?.message ?? err);
      // Last ditch: the direct child. Its own children may survive, but a
      // caller waiting on this client is better off than with nothing sent.
      try { target.kill("SIGKILL"); } catch { /* already gone */ }
    }
    return { server, escalated: true, method: forcedAction, graceMs, pid, error };
  };

  return new Promise<TerminationReport>((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const quiet = (): TerminationReport => ({ server, escalated: false, method: gracefulAction, graceMs, pid });
    const finish = (r: TerminationReport): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    // A server that honours the graceful signal ends here: a quiet death.
    target.onExit(() => finish(quiet()));

    let gracefulError: string | undefined;
    try {
      act(true);
    } catch (err: any) {
      gracefulError = String(err?.message ?? err);
    }
    if (done) return; // it was already gone, and said so
    if (gracefulError !== undefined) {
      // A signal that could not be delivered at all (ESRCH: already gone) is a
      // quiet death, not a reason to escalate.
      finish(target.alive() ? force() : { server, escalated: false, method: "none", graceMs, pid });
      return;
    }

    // The grace period. Unref'd: a server that ignores SIGTERM must not hold
    // the agent's event loop open while we wait to force it. A target that
    // ended without ever telling us is still a quiet death — only a LIVE tree
    // is ever forced, so a late timer can never signal something already gone.
    timer = setTimeout(() => finish(target.alive() ? force() : quiet()), graceMs);
    timer.unref?.();
  });
}

/** The one-line description of a termination, for logs and banners. */
export function describeTermination(r: TerminationReport): string {
  if (r.method === "none") return `server "${r.server}" was already gone`;
  if (!r.escalated) return `server "${r.server}" exited on ${r.method}`;
  const pid = r.pid === undefined ? "" : ` (pid ${r.pid})`;
  return (
    `server "${r.server}" ignored ${r.method === "SIGKILL" ? "SIGTERM" : "taskkill /T"} and had to be ` +
    `killed as a process tree with ${r.method}${pid} after ${r.graceMs}ms` +
    `${r.error ? `; the forced kill also failed: ${r.error}` : ""}`
  );
}

/**
 * Where terminated servers are reported. A quiet death says nothing — the
 * point of 11(a) is that the OTHER kind (a server that had to be escalated)
 * is not silent. The `mcp: ` prefix matches the startup banner's lines in
 * bin/mnemo.ts.
 */
export function defaultTerminationReporter(r: TerminationReport): void {
  if (!r.escalated) return;
  console.error(`mcp: ${describeTermination(r)}`);
}

let reportTermination: (r: TerminationReport) => void = defaultTerminationReporter;

export function setTerminationReporter(fn: (r: TerminationReport) => void): void {
  reportTermination = fn;
}

/** Every client whose server may still be running. */
const liveClients = new Set<McpClient>();
let exitHookInstalled = false;

/**
 * 11(a), last line of defence: servers are spawned detached on POSIX (a new
 * process group is what makes tree kills possible), so they no longer sit in
 * the agent's group and a dying agent does not take them with it. Force-kill
 * every live tree as the process goes down. Signalling is synchronous, so this
 * works from an 'exit' handler; an agent killed by a signal it does not handle
 * gets no chance to run any of this, which is why stop() must not be the only
 * path.
 */
function killLiveTreesOnExit(): void {
  for (const c of [...liveClients]) {
    try { c.forceKillTree(); } catch { /* dying anyway */ }
  }
}

function trackLiveClient(client: McpClient): void {
  liveClients.add(client);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", killLiveTreesOnExit);
  }
}

/** One MCP server process, speaking JSON-RPC 2.0 over stdio. */
export class McpClient {
  // written out rather than constructor parameter properties: this repo runs
  // on node's type stripping, which rejects those outright
  readonly name: string;
  private readonly config: McpServerConfig;
  private readonly timeoutMs: number;
  private proc: McpProcess | null = null;
  /** The process being torn down by stop(); see forceKillTree(). */
  private killing: McpProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail: string[] = [];
  /** Teardown of the last stop(); see whenStopped(). */
  private teardown: Promise<TerminationReport> | null = null;
  /** Grace before the forced kill; tests shrink it. */
  terminateGraceMs = MCP_TERMINATE_GRACE_MS;
  /** OS actions for teardown; tests swap in a recorder (11a). */
  killSystem: KillSystem = DEFAULT_KILL_SYSTEM;

  constructor(name: string, config: McpServerConfig, timeoutMs = 15_000) {
    this.name = name;
    this.config = config;
    this.timeoutMs = timeoutMs;
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  start(): void {
    if (this.alive) return;
    const proc: McpProcess = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      // 12.7: an MCP server is third-party code; it never needs OUR keys
      env: { ...scrubChildEnv(), ...(this.config.env ?? {}) },
      // 11(a): its own process GROUP on POSIX, so stop() can signal the whole
      // tree (`uvx graft-mcp` is a launcher, the server is its grandchild) with
      // a negative-pid kill. Not on Windows: there the tree comes from
      // `taskkill /T`, and detached would only hand the server its own console.
      detached: process.platform !== "win32",
    });
    this.adopt(proc);
  }

  /**
   * Wire an already-spawned server process to this client. start() calls it
   * right after spawning; tests call it with a fake process object, so no real
   * server is ever launched (and none of this needs a POSIX shell).
   */
  adopt(proc: McpProcess): void {
    this.proc = proc;
    this.buffer = "";
    trackLiveClient(this);
    proc.stdout?.on("data", (chunk) => this.handleChunk(chunk));
    proc.stderr?.on("data", (chunk) => {
      this.stderrTail.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    proc.once("exit", () => {
      if (this.proc === proc) this.proc = null;
      if (this.killing === proc) this.killing = null;
      liveClients.delete(this);
      const why = new Error(`mcp server "${this.name}" exited: ${this.stderrTail.join("").slice(-400)}`);
      for (const [, p] of [...this.pending.entries()]) p.reject(why);
      this.pending.clear();
    });
    proc.once("error", (err) => {
      const why = new Error(`mcp server "${this.name}" failed to start: ${err?.message ?? err}`);
      for (const [, p] of [...this.pending.entries()]) p.reject(why);
      this.pending.clear();
    });
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers do print non-protocol noise; ignore it
      }
      // notifications have no id and need no reply
      if (msg?.id === undefined || msg?.id === null) continue;
      const p = this.pending.get(Number(msg.id));
      if (!p) continue;
      this.pending.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(String(msg.error?.message ?? JSON.stringify(msg.error))));
      else p.resolve(msg.result);
    }
  }

  private notify(method: string, params: unknown = {}): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** One request. Rejects on timeout so a wedged server cannot hang startup. */
  request(method: string, params: unknown = {}): Promise<any> {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp server "${this.name}" timed out on ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** The MCP handshake: initialize, then the initialized notification. */
  async initialize(): Promise<any> {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "mnemo", version: "0.1.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async listTools(): Promise<any[]> {
    const res = await this.request("tools/list");
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args });
    const text = flattenContent(res?.content);
    if (res?.isError) throw new Error(text || `mcp tool ${name} reported an error`);
    return text;
  }

  /** 4.5: keep image blocks as images instead of flattening them to a label. */
  async callToolRich(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res?.isError) {
      throw new Error(flattenContent(res?.content) || `mcp tool ${name} reported an error`);
    }
    return { content: toToolContent(res?.content) };
  }

  /**
   * 11(a): take down the whole server TREE, gracefully then forcefully.
   *
   * Three things matter here, and none of them is "send SIGTERM":
   *  - in-flight requests are settled NOW. A server that is going away will
   *    never answer, and a caller must not be left waiting on a pipe that will
   *    not close (the failure mode this fixes) instead of on a rejection;
   *  - our end of the pipes is released, so a surviving grandchild holding the
   *    write end cannot keep this side open;
   *  - the kill escalates: SIGTERM to the group, SIGKILL after the grace
   *    period (taskkill /T → /T /F on Windows), and a server that needed the
   *    force is REPORTED rather than dying quietly. See whenStopped().
   */
  stop(): void {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    // NOT removed from liveClients: the tree may outlive this call (it is the
    // point of the grace period), and the exit-time sweep must still see it.
    this.killing = proc;
    const why = new Error(`mcp server "${this.name}" was stopped`);
    for (const [, p] of [...this.pending.entries()]) p.reject(why);
    this.pending.clear();
    try { proc.stdin?.end(); } catch { /* already gone */ }
    try { proc.stdout?.destroy?.(); proc.stderr?.destroy?.(); } catch { /* already gone */ }
    const teardown = terminateTree(
      {
        pid: proc.pid,
        alive: () => proc.exitCode === null && proc.signalCode === null,
        onExit: (fn) => { proc.once("exit", fn); },
        kill: (signal) => proc.kill(signal),
      },
      this.name,
      { graceMs: this.terminateGraceMs, kill: this.killSystem },
    );
    this.teardown = teardown.then((report) => {
      reportTermination(report);
      return report;
    });
  }

  /**
   * The teardown of the last stop(): resolves with the report once the tree is
   * gone, or once the forced kill has been delivered to a server that would not
   * go. Resolves null for a client that was never started. Never rejects.
   */
  whenStopped(): Promise<TerminationReport | null> {
    return this.teardown ?? Promise.resolve(null);
  }

  /**
   * Synchronous last-resort tree kill for process exit (11a). Fire-and-forget
   * by design: an 'exit' handler has no event loop left to await anything in,
   * so this only sends the signal and returns.
   */
  forceKillTree(): void {
    const proc = this.proc ?? this.killing;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const pid = proc.pid;
    if (pid === undefined) {
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
      return;
    }
    try {
      if (this.killSystem.platform === "win32") this.killSystem.taskkill?.(pid, true);
      else this.killSystem.signal?.(pid, "SIGKILL");
    } catch {
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
    }
  }
}

/** MCP content blocks -> the text a model can read. */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => {
      if (c?.type === "text") return String(c.text ?? "");
      if (c?.type === "resource") return String(c?.resource?.text ?? c?.resource?.uri ?? "");
      // images and anything else: name it rather than dropping it silently
      return `[${String(c?.type ?? "unknown")} content]`;
    })
    .join("");
}

/**
 * MCP content blocks -> pi tool-result blocks. Images survive as images;
 * everything else is reduced to text.
 */
export function toToolContent(content: unknown): ToolResult["content"] {
  if (!Array.isArray(content) || content.length === 0) {
    return [{ type: "text", text: "" }];
  }
  const out: ToolResult["content"] = [];
  for (const c of content as any[]) {
    if (c?.type === "image" && typeof c?.data === "string") {
      out.push({ type: "image", data: c.data, mimeType: String(c.mimeType ?? "image/png") } as ImageContent);
    } else {
      out.push({ type: "text", text: flattenContent([c]) });
    }
  }
  return out;
}

/** Wrap one MCP tool descriptor as a Mnemo tool. */
export function toSeaTool(client: McpClient, descriptor: any): SeaTool {
  const remoteName = String(descriptor?.name ?? "");
  return {
    name: mcpToolName(client.name, remoteName),
    label: `${client.name}: ${remoteName}`,
    description: String(descriptor?.description ?? `${remoteName} (via MCP server ${client.name})`),
    // MCP inputSchema is already JSON Schema, which is what pi wants
    parameters: (descriptor?.inputSchema ?? { type: "object", properties: {} }) as any,
    async execute(_id, params) {
      return client.callToolRich(remoteName, (params ?? {}) as Record<string, unknown>);
    },
  };
}

export interface McpDiscovery {
  tools: SeaTool[];
  clients: McpClient[];
  /** One entry per server that could not be reached, for the startup banner. */
  errors: Array<{ server: string; error: string }>;
}

/**
 * Connect to every configured server and return their tools.
 * A server that fails is reported, never fatal: one broken entry in mcp.json
 * must not stop the agent from starting.
 */
export async function discoverMcpTools(
  config: McpConfig,
  makeClient: (name: string, cfg: McpServerConfig) => McpClient =
    (name, cfg) => new McpClient(name, cfg),
): Promise<McpDiscovery> {
  const out: McpDiscovery = { tools: [], clients: [], errors: [] };
  for (const [name, cfg] of Object.entries(config.servers)) {
    if (cfg.disabled) continue;
    const client = makeClient(name, cfg);
    try {
      await client.initialize();
      const descriptors = await client.listTools();
      out.tools.push(...descriptors.map((d) => toSeaTool(client, d)));
      out.clients.push(client);
    } catch (err: any) {
      client.stop();
      out.errors.push({ server: name, error: String(err?.message ?? err) });
    }
  }
  return out;
}

// --- registration handoff --------------------------------------------------
// Discovery is async but pi's extension factory is not, so the CLI discovers
// before calling main() and parks the result here.

let discovered: SeaTool[] = [];

export function setMcpTools(tools: SeaTool[]): void {
  discovered = tools;
}

export function getMcpTools(): SeaTool[] {
  return discovered;
}
