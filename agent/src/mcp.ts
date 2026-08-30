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
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { textResult, type SeaTool } from "./tools/types.ts";

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

/** One MCP server process, speaking JSON-RPC 2.0 over stdio. */
export class McpClient {
  // written out rather than constructor parameter properties: this repo runs
  // on node's type stripping, which rejects those outright
  readonly name: string;
  private readonly config: McpServerConfig;
  private readonly timeoutMs: number;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail: string[] = [];

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
    const proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.config.env ?? {}) },
    });
    this.proc = proc;
    this.buffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString("utf8"));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    proc.once("exit", () => {
      if (this.proc === proc) this.proc = null;
      const why = new Error(`mcp server "${this.name}" exited: ${this.stderrTail.join("").slice(-400)}`);
      for (const [, p] of [...this.pending.entries()]) p.reject(why);
      this.pending.clear();
    });
    proc.once("error", (err) => {
      const why = new Error(`mcp server "${this.name}" failed to start: ${err.message}`);
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

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    proc?.stdin?.end();
    proc?.kill();
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
      return textResult(await client.callTool(remoteName, (params ?? {}) as Record<string, unknown>));
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
