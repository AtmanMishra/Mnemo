/**
 * MCP servers as tools: pi's own MCP client (stdio and streamable HTTP, OAuth sign-in, `/mcp`),
 * with the servers read from `$MNEMO_HOME/agent/mcp.json` and, for a folder you trusted, its
 * `.pi/mcp.json`, in the `mcpServers` shape other clients use. An HTTP server is the one place
 * besides the model provider Mnemo connects to on its own, so it needs `"allowNetwork": true`
 * in your own file.
 *
 * Mnemo has no codemode VM (its Python kernel does that job), so a server's tools default to
 * `deferred`, not pi's `codemode`: they stay out of the prompt until `tool_search` finds them,
 * which keeps a small model's context and bill small. `direct` declares them up front, `hidden`
 * removes them. Every call goes through the permission gate (extensions/policy.ts).
 *
 * Only the session you talk to connects: sub-agents get no MCP tools.
 *
 * A stdio server starts from the allowlisted environment the agent's commands get
 * (runtime/env.ts) plus the `env` its entry names, not from all of yours: pi's own
 * transport inherits everything, so Mnemo builds the transports itself.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMcpExtension, createToolSearchExtension, type InlineExtension, type LoadedMcpConfig, type McpServerEntry, type McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { baseEnv, configuredKeys } from "../runtime/env.ts";
import type { Host } from "./host.ts";

const NAME = /^[A-Za-z0-9_-]+$/;
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** `codemode` (and its alias) needs pi's codemode VM, which Mnemo does not load: those tools are found by search instead. */
function exposureOf(v: unknown): unknown {
  return v === undefined || v === "codemode" || v === "codemode-deferred" ? "deferred" : v;
}

function withExposures(config: Raw): Raw {
  const out: Raw = { ...config, exposure: exposureOf(config.exposure) };
  if (isRecord(config.toolExposure)) out.toolExposure = Object.fromEntries(Object.entries(config.toolExposure).map(([k, v]) => [k, exposureOf(v)]));
  return out;
}

function read(file: string, scope: "global" | "project", servers: Map<string, McpServerEntry>, errors: string[]): void {
  if (!fs.existsSync(file)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${file}: expected an object with an "mcpServers" object`);
    return;
  }
  for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
    if (!NAME.test(name) || !isRecord(value)) {
      errors.push(`${file}: server "${name}" must be an object named with letters, digits, "_" and "-"`);
      continue;
    }
    const override = value.command === undefined && value.url === undefined && value.type === undefined;
    if (scope === "project" && override) {
      // Turns a server of yours off (or changes its exposure) here, keeping what the project could not set.
      const base = servers.get(name);
      if (!base || Object.keys(value).some((k) => !OVERRIDE_KEYS.includes(k))) {
        errors.push(`${file}: server "${name}" needs "command" or "url", or may only set ${OVERRIDE_KEYS.join(", ")} of a server in your own mcp.json`);
        continue;
      }
      servers.set(name, { ...base, config: withExposures({ ...base.config, ...value }) as never, override: file });
      continue;
    }
    if (typeof value.command !== "string" && typeof value.url !== "string") {
      errors.push(`${file}: server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`);
      continue;
    }
    // Mnemo talks only to your model provider unless you name another place: an HTTP server is
    // off until its entry in your own mcp.json says so. A repository cannot add one (nor, with
    // it, choose where one of your provider credentials is sent with `auth`).
    if (value.url !== undefined && (scope === "project" || value.allowNetwork !== true)) {
      errors.push(
        scope === "project"
          ? `${file}: server "${name}" is reached over the network; only your own mcp.json may add one, with "allowNetwork": true`
          : `${file}: server "${name}" is reached over the network; add "allowNetwork": true to its entry to allow that`,
      );
      continue;
    }
    // A repository must not hand one of your variables to its server by naming it.
    if (scope === "project" && isRecord(value.env) && Object.values(value.env).some((v) => typeof v === "string" && /\$\{?[A-Za-z_]/.test(v.replaceAll("$$", "")))) {
      errors.push(`${file}: server "${name}": env may only name your variables ($NAME) in your own mcp.json`);
      continue;
    }
    servers.set(name, { name, config: withExposures(value) as never, source: file, scope });
  }
}

/** Your servers, then a trusted project's, which replace yours of the same name. */
export function loadMcpServers(agentDir: string, cwd: string, projectTrusted: boolean): LoadedMcpConfig {
  const servers = new Map<string, McpServerEntry>();
  const errors: string[] = [];
  read(path.join(agentDir, "mcp.json"), "global", servers, errors);
  const projectConfig = projectTrusted ? path.join(cwd, ".pi", "mcp.json") : undefined;
  if (projectConfig) read(projectConfig, "project", servers, errors);
  return { servers: [...servers.values()], autoEnableCodemode: false, errors, ...(projectConfig ? { projectConfig } : {}) };
}

/** A config value as pi reads it: `!command` is the command's output; `$NAME` and `${NAME}` interpolate; `$$` and `$!` escape. */
function resolveValue(value: string, what: string): string {
  if (value.startsWith("!")) {
    let out: string | undefined;
    try {
      out = execSync(value.slice(1), { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || undefined;
    } catch {}
    if (out === undefined) throw new Error(`Failed to resolve ${what} from shell command: ${value.slice(1)}`);
    return out;
  }
  const missing: string[] = [];
  const out = value.replace(/\$(?:([$!])|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_m, escaped?: string, braced?: string, bare?: string) => {
    if (escaped) return escaped;
    const v = process.env[(braced ?? bare)!];
    if (!v) missing.push((braced ?? bare)!);
    return v ?? "";
  });
  if (missing.length) throw new Error(`Failed to resolve ${what} from environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  return out;
}

function resolveAll(values: Record<string, string> | undefined, what: (key: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [k, resolveValue(v, what(k))]));
}

const expandHome = (p: string): string => (p === "~" ? os.homedir() : p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\")) ? path.join(os.homedir(), p.slice(2)) : p);

/** pi's transports, except that a stdio server does not inherit the environment. */
export function mcpTransport(agentDir: string): McpTransportFactory {
  return (entry, cwd, authProvider) => {
    const { config, name } = entry;
    if ("url" in config) {
      const headers = config.headers && resolveAll(config.headers, (k) => `MCP server "${name}" header "${k}"`);
      return new StreamableHttpTransport({ url: config.url, headers, authProvider });
    }
    return new StdioTransport({
      command: expandHome(config.command),
      args: config.args?.map(expandHome),
      cwd: path.resolve(cwd, expandHome(config.cwd ?? ".")),
      env: { ...baseEnv(process.env, configuredKeys(agentDir)), ...resolveAll(config.env, (k) => `MCP server "${name}" env "${k}"`) },
      inheritEnv: false,
      stderr: "pipe",
    });
  };
}

export function mcpExtensions(host: Host): InlineExtension[] {
  if (host.depth > 0) return [];
  return [
    { name: "tool-search", factory: createToolSearchExtension() },
    {
      name: "mcp",
      factory: createMcpExtension({ loadConfig: (ctx) => loadMcpServers(host.agentDir, ctx.cwd, ctx.isProjectTrusted()), createTransport: mcpTransport(host.agentDir) }),
    },
  ];
}
