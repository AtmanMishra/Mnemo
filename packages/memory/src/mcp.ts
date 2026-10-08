/**
 * Memory as an MCP server (stdio), for agents that speak MCP but have no
 * hooks — Codex, Cursor, opencode — or as tools beside the hooks in Claude
 * Code. Three tools:
 *
 *   memory_recall    what memory knows for a task: the project and user
 *                    profiles, the last session, relevant pitfalls and fixes
 *   memory_search    search within this project
 *   memory_remember  keep a durable fact
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout, the MCP stdio transport.
 * Hand-written: the protocol subset is small, and the package stays free of
 * dependencies. Each tool takes an optional `cwd`, because not every client
 * starts its servers in the project directory.
 */
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { MemoryService } from "./service.ts";
import { MemorySession, type Source } from "./session.ts";
import { describeSessionHits, type SessionIndex } from "./sessions.ts";

export interface McpOptions {
  memory: MemoryService;
  userSkillsDir: string;
  /** Used when a call does not name one. */
  cwd: string;
  source?: Source;
  version?: string;
  /** Past-session search; the tool is offered only when this is given. */
  sessions?: SessionIndex;
}

const PROTOCOL = "2025-06-18";

const cwdProp = { type: "string", description: "The project directory (default: where the server was started)" };

export const MCP_TOOLS = [
  {
    name: "memory_recall",
    description:
      "Call at the start of a task. Returns what long-term memory knows for it: this project's conventions and commands, the user's preferences, " +
      "the last session's open work, and pitfalls with their known fixes. Apply a recalled fix before the command it is about.",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "The task, in the user's words" }, cwd: cwdProp }, required: ["task"] },
  },
  {
    name: "memory_search",
    description: "Search long-term memory for this project: conventions, past sessions, pitfalls and their fixes, skills.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, k: { type: "number", description: "How many results (default 5)" }, cwd: cwdProp },
      required: ["query"],
    },
  },
  {
    name: "memory_remember",
    description:
      "Keep a durable fact: scope 'project' for this codebase, 'user' for the person's preferences. A short stable key; the same key replaces " +
      "the old value. Not for deferred work or the status of the current task.",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["project", "user"] }, key: { type: "string" }, value: { type: "string" }, cwd: cwdProp },
      required: ["scope", "key", "value"],
    },
  },
];

export const SESSION_SEARCH_TOOL = {
  name: "session_search",
  description:
    "Search what was actually said and run in past sessions of this project (this agent's and others', e.g. Claude Code's). Use it when the user refers to earlier work.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, k: { type: "number" }, all_projects: { type: "boolean" }, cwd: cwdProp },
    required: ["query"],
  },
};

type Request = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export function serveMcp(o: McpOptions, input: Readable, output: Writable): Promise<void> {
  const sessions = new Map<string, MemorySession>();
  const sessionFor = (cwd?: unknown) => {
    const dir = path.resolve(typeof cwd === "string" && cwd ? cwd : o.cwd);
    let s = sessions.get(dir);
    if (!s) sessions.set(dir, (s = new MemorySession({ memory: o.memory, cwd: dir, userSkillsDir: o.userSkillsDir, source: o.source })));
    return s;
  };
  const send = (msg: object) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

  const call = async (name: string, a: Record<string, unknown>) => {
    const s = sessionFor(a.cwd);
    if (name === "session_search" && o.sessions)
      return text(describeSessionHits(o.sessions.search(String(a.query ?? ""), { k: typeof a.k === "number" ? a.k : 8, under: a.all_projects ? undefined : s.identity.root })));
    if (name === "memory_recall") {
      const r = await s.context(String(a.task ?? ""), { lastSession: true });
      return text([r.system.trim(), r.message].filter(Boolean).join("\n\n"));
    }
    if (name === "memory_search") return text(await s.search(String(a.query ?? ""), typeof a.k === "number" ? a.k : 5));
    if (name === "memory_remember") {
      const scope = a.scope === "user" ? "user" : "project";
      const r = await s.remember(scope, String(a.key ?? ""), String(a.value ?? ""));
      return text(r.superseded ? `Updated ${String(a.key)} (the old value is kept as history).` : `Remembered ${String(a.key)}.`);
    }
    throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  };

  const handle = async (req: Request) => {
    const respond = req.id !== undefined && req.id !== null;
    try {
      switch (req.method) {
        case "initialize":
          return send({
            id: req.id,
            result: {
              protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : PROTOCOL,
              capabilities: { tools: {} },
              serverInfo: { name: "mnemo-memory", version: o.version ?? "0.1.0" },
              instructions: "Mnemo's long-term memory for this project. Call memory_recall at the start of a task.",
            },
          });
        case "ping":
          return send({ id: req.id, result: {} });
        case "tools/list":
          return send({ id: req.id, result: { tools: o.sessions ? [...MCP_TOOLS, SESSION_SEARCH_TOOL] : MCP_TOOLS } });
        case "tools/call": {
          const name = String(req.params?.name ?? "");
          try {
            return send({ id: req.id, result: await call(name, (req.params?.arguments ?? {}) as Record<string, unknown>) });
          } catch (error) {
            if ((error as { code?: number }).code === -32602) throw error;
            // A tool that failed is a result the model can read, not a protocol error.
            return send({ id: req.id, result: text(error instanceof Error ? error.message : String(error), true) });
          }
        }
        default:
          // Notifications (initialized, cancelled) need no answer.
          if (respond) send({ id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
      }
    } catch (error) {
      if (respond) send({ id: req.id, error: { code: (error as { code?: number }).code ?? -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  };

  return new Promise((resolve) => {
    const lines = createInterface({ input });
    // One at a time, in arrival order: a recall must see the remember sent before it.
    let chain: Promise<unknown> = Promise.resolve();
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        send({ id: null, error: { code: -32700, message: "parse error" } });
        return;
      }
      chain = chain.then(() => handle(req));
    });
    lines.on("close", () => void chain.then(() => resolve()));
  });
}
