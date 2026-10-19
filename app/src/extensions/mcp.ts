/**
 * MCP servers as tools: pi's own MCP client (stdio and streamable HTTP, OAuth sign-in, `/mcp`),
 * with the servers read from `$MNEMO_HOME/agent/mcp.json` and, for a folder you trusted, its
 * `.pi/mcp.json`, in the `mcpServers` shape other clients use.
 *
 * Mnemo has no codemode VM (its Python kernel does that job), so a server's tools default to
 * `deferred`, not pi's `codemode`: they stay out of the prompt until `tool_search` finds them,
 * which keeps a small model's context and bill small. `direct` declares them up front, `hidden`
 * removes them. Every call goes through the permission gate (extensions/policy.ts).
 *
 * Only the session you talk to connects: sub-agents get no MCP tools.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createMcpExtension, createToolSearchExtension, type InlineExtension, type LoadedMcpConfig, type McpServerEntry } from "@earendil-works/pi-coding-agent";
import type { Host } from "./host.ts";
import { loadManaged, nameAllowed } from "../policy/managed.ts";

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
    // A repository must not choose where one of your provider credentials is sent.
    if (scope === "project" && value.auth !== undefined) {
      errors.push(`${file}: server "${name}": auth is only allowed in your own mcp.json`);
      continue;
    }
    servers.set(name, { name, config: withExposures(value) as never, source: file, scope });
  }
}

/** Your servers, then a trusted project's, which replace yours of the same name. */
export function loadMcpServers(agentDir: string, cwd: string, projectTrusted: boolean, managedFile?: string): LoadedMcpConfig {
  const servers = new Map<string, McpServerEntry>();
  const errors: string[] = [];
  read(path.join(agentDir, "mcp.json"), "global", servers, errors);
  const projectConfig = projectTrusted ? path.join(cwd, ".pi", "mcp.json") : undefined;
  if (projectConfig) read(projectConfig, "project", servers, errors);
  // The administrator's list is the last word, whoever's mcp.json named the server.
  const managed = managedFile === undefined ? undefined : loadManaged(managedFile);
  const allowed = managed?.error ? [] : managed?.mcpServers;
  for (const name of servers.keys())
    if (!nameAllowed(allowed, name)) {
      servers.delete(name);
      errors.push(`server "${name}" is not allowed by the managed policy (${managed!.file})`);
    }
  return { servers: [...servers.values()], autoEnableCodemode: false, errors, ...(projectConfig ? { projectConfig } : {}) };
}

export function mcpExtensions(host: Host): InlineExtension[] {
  if (host.depth > 0) return [];
  return [
    { name: "tool-search", factory: createToolSearchExtension() },
    { name: "mcp", factory: createMcpExtension({ loadConfig: (ctx) => loadMcpServers(host.agentDir, ctx.cwd, ctx.isProjectTrusted(), host.managedFile) }) },
  ];
}
