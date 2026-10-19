/**
 * Language-server diagnostics after an edit: the cheap model finds out that its change does
 * not type-check in the same result that reports the edit, not three turns later.
 *
 * Off until the user names a server in `$MNEMO_HOME/lsp.json`:
 *
 *   {"servers": {"typescript": {"command": ["typescript-language-server", "--stdio"],
 *                               "files": {"*.ts": "typescript", "*.tsx": "typescriptreact"}}}}
 *
 * `command` is a program and its arguments, run without a shell, the program found on PATH's
 * absolute entries; `files` maps a file-name glob to the LSP language id. A folder's own
 * `lsp.json` is never read: a language server runs code from the project it checks (a TypeScript
 * plugin, a build script), so it starts only in a folder the user trusted, and only the
 * servers the user chose. It gets the bash tool's scrubbed environment. Only the session the
 * user talks to starts servers; a sub-agent's edits are checked by none.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trustedBin } from "../runtime/bin.ts";
import { childEnv, configuredKeys } from "../runtime/env.ts";
import { LspClient, type Diagnostic } from "../lsp/client.ts";
import { globMatch } from "./policy.ts";
import type { Host } from "./host.ts";

export interface LspServer {
  name: string;
  command: string[];
  /** File-name glob → language id. */
  files: Record<string, string>;
  /** Seconds to wait for a result after an edit; 10 when absent. */
  timeout: number;
}

const MAX_SHOWN = 15;
const MAX_FILE = 1_000_000;

export function loadLsp(home: string): { servers: LspServer[]; errors: string[] } {
  const file = path.join(home, "lsp.json");
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return { servers: [], errors };
  }
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const list = isRecord(raw) ? raw.servers : undefined;
  if (!isRecord(list)) return { servers: [], errors: [...errors, `${file}: expected {"servers": {…}}`] };
  const servers: LspServer[] = [];
  for (const [name, s] of Object.entries(list)) {
    const ok =
      isRecord(s) &&
      Array.isArray(s.command) &&
      s.command.length > 0 &&
      s.command.every((w) => typeof w === "string") &&
      isRecord(s.files) &&
      Object.keys(s.files).length > 0 &&
      Object.values(s.files).every((v) => typeof v === "string") &&
      (s.timeout === undefined || (typeof s.timeout === "number" && s.timeout > 0));
    if (!ok) errors.push(`${file}: server "${name}" needs "command" (a program and its arguments) and "files" (a glob → language id map)`);
    else servers.push({ name, command: s.command as string[], files: s.files as Record<string, string>, timeout: (s.timeout as number | undefined) ?? 10 });
  }
  return { servers, errors };
}

/** The server for a file and the language id it wants, by the first glob that matches the file name. */
export function serverFor(servers: LspServer[], file: string): { server: LspServer; languageId: string } | undefined {
  const base = path.basename(file);
  for (const server of servers)
    for (const [glob, languageId] of Object.entries(server.files)) if (globMatch(glob, base)) return { server, languageId };
  return undefined;
}

const SEVERITY = ["", "error", "warning", "info", "hint"];

/** Errors and warnings as lines the model can act on, most severe first, capped. */
export function describe(rel: string, server: string, found: Diagnostic[]): string | undefined {
  const real = found.filter((d) => d.severity <= 2).sort((a, b) => a.severity - b.severity || a.line - b.line);
  if (real.length === 0) return undefined;
  const lines = real.slice(0, MAX_SHOWN).map((d) => {
    const message = d.message.split("\n")[0]!.slice(0, 240);
    return `  ${rel}:${d.line}:${d.column} ${SEVERITY[d.severity]}${d.code ? ` ${d.source ? `${d.source} ` : ""}${d.code}` : d.source ? ` ${d.source}` : ""}: ${message}`;
  });
  if (real.length > MAX_SHOWN) lines.push(`  …and ${real.length - MAX_SHOWN} more`);
  return `Language server (${server}) reports on ${rel} after this change:\n${lines.join("\n")}`;
}

export function lspExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    if (host.depth > 0) return;
    const { servers, errors } = loadLsp(host.home);
    const running = new Map<string, Promise<LspClient | undefined>>();
    const gaveUp = new Set<string>();

    pi.on("session_start", (_event, ctx) => {
      for (const e of errors) ctx.ui.notify(`lsp: ${e}`, "warning");
    });

    pi.on("session_shutdown", async () => {
      const all = [...running.values()];
      running.clear();
      await Promise.all(all.map(async (p) => (await p)?.close().catch(() => {})));
    });

    pi.on("tool_result", async (event, ctx) => {
      if (servers.length === 0 || event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return undefined;
      // Servers run the project's own code (plugins, build scripts): only in a folder the user trusted.
      if (!ctx.isProjectTrusted()) return undefined;
      const given = event.input.path;
      if (typeof given !== "string") return undefined;
      const file = path.resolve(ctx.cwd, given.startsWith("@") ? given.slice(1) : given);
      const match = serverFor(servers, file);
      if (!match || gaveUp.has(match.server.name)) return undefined;
      let text: string;
      try {
        if (fs.statSync(file).size > MAX_FILE) return undefined;
        text = fs.readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
      const { server, languageId } = match;
      let client = running.get(server.name);
      if (!client) {
        client = start(server, ctx.cwd, host.agentDir, (why) => ctx.ui.notify(`lsp: ${server.name} ${why}; it is off for this session`, "warning"));
        running.set(server.name, client);
      }
      const live = await client;
      if (!live || live.dead) {
        gaveUp.add(server.name);
        return undefined;
      }
      const found = await live.diagnose(file, text, languageId, server.timeout * 1000).catch(() => undefined);
      if (live.dead) gaveUp.add(server.name);
      const note = found && describe(path.relative(ctx.cwd, file) || file, server.name, found);
      return note ? { content: [...event.content, { type: "text" as const, text: note }] } : undefined;
    });
  };
}

async function start(server: LspServer, cwd: string, agentDir: string, off: (why: string) => void): Promise<LspClient | undefined> {
  const [program, ...args] = server.command;
  const exe = path.isAbsolute(program!) ? program! : trustedBin(program!);
  if (!exe) return void off(`could not start (${program} is not on PATH)`);
  try {
    return await LspClient.start({ command: [exe, ...args], cwd, env: childEnv(process.env, configuredKeys(agentDir)) });
  } catch (error) {
    return void off(`could not start (${error instanceof Error ? error.message : String(error)})`);
  }
}
