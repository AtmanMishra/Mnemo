/**
 * AREA 9.5 — `/hook list|test|add|disable|enable`.
 *
 * Pure command logic: returns the report string (the extension notifies with
 * it) so tests drive it without a TUI. `add` scaffolds a manifest into the
 * chosen scope, and when the command names an in-root script it scaffolds a
 * stub too — a node stub for a `.js` hook (the shape that runs on every
 * platform), an `sh` stub for a path that asks for one. Harness bundles are a
 * later increment.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { HookEngine } from "./engine.ts";
import { executeHook } from "./executor.ts";
import { globalHookRoot, projectHookRoot, userHookRoot, validateManifest } from "./scanner.ts";
import { SCOPES, type Scope, type Trigger, TRIGGERS, isTrigger } from "./types.ts";

export interface CommandUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  confirm?(title: string, message: string): Promise<boolean>;
}

export interface HookCommandCtx {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  ui: CommandUI;
  engine: HookEngine;
}

const USAGE = [
  "usage:",
  "  /hook list",
  "  /hook test <id> [tool] [jsonArgs]",
  "  /hook add <id> --trigger <Trigger> [--tool <regex>] [--path <glob>] --command <cmd>",
  "            [--scope project|user|global] [--timeout <sec>] [--block] [--modify]",
  "            [--no-audit] [--description <text>] [-y]",
  "  /hook disable <id>   (or  enable <scope:id>)",
].join("\n");

/**
 * Split on whitespace, honouring single/double quotes. pi passes command
 * args verbatim (no shell), so `/hook add ... --description 'two words'`
 * arrives with the quotes intact; without this, the space inside would split
 * the value in half.
 */
export function tokenize(args: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Slash-free command args, e.g. "list" or "test audit-store write_file {...}". */
export async function runHookCommand(args: string, ctx: HookCommandCtx): Promise<string> {
  const tokens = tokenize(args);
  const sub = tokens[0] ?? "";
  switch (sub) {
    case "list": case "ls": return hookList(ctx);
    case "test": return hookTest(tokens.slice(1), ctx);
    case "add": return hookAdd(tokens.slice(1), ctx);
    case "disable": return hookDisable(tokens.slice(1), ctx);
    case "enable": return hookEnable(tokens.slice(1), ctx);
    case "help": case "": return USAGE;
    default:
      return `unknown /hook subcommand "${sub}"\n\n${USAGE}`;
  }
}

function fmtScope(scope: Scope): string {
  return scope === "project" ? "project" : scope === "user" ? "user" : "global";
}

function hookList(ctx: HookCommandCtx): string {
  const reg = ctx.engine.registry(ctx.cwd);
  const disabled = reg.disabled;
  const rows: string[] = [`hooks (${reg.hooks().length} effective, ${disabled.size} disabled)`];
  for (const { scope, root, hooks } of reg.perScope()) {
    if (hooks.length === 0) continue;
    rows.push(`[${fmtScope(scope)}] ${root}`);
    for (const h of hooks) {
      const eff = reg.byId(h.id)?.scope === scope;
      const tag = reg.isDisabled(h.id, scope) ? " disabled" : eff ? "" : " (overridden)";
      const matcher = [h.matcher?.tool && `tool=${h.matcher.tool}`, h.matcher?.path && `path=${h.matcher.path}`]
        .filter(Boolean).join(" ") || "any";
      rows.push(`  ${h.id}  ${h.trigger}  ${matcher}  ${h.command}${tag}`);
    }
  }
  if (rows.length === 1) rows.push("(no hooks — /hook add scaffolds one)");
  return rows.join("\n");
}

interface AddFlags {
  id?: string;
  trigger: Trigger | null;
  tool?: string;
  pathGlob?: string;
  command: string | null;
  scope: Scope;
  timeout?: number;
  block?: boolean;
  modify?: boolean;
  audit: boolean;
  description?: string;
  force: boolean;
}

function parseAddFlags(tokens: string[], env: NodeJS.ProcessEnv): { flags: AddFlags; error?: string } {
  const flags: AddFlags = { trigger: null, command: null, scope: "user", audit: true, force: false };
  const id = tokens[0];
  if (!id) return { flags, error: "usage: /hook add <id> --trigger PreToolUse ...\n\n" + USAGE };
  flags.id = id;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const next = (): string | undefined => tokens[++i];
    switch (t) {
      case "--trigger": { const v = next(); if (!v || !isTrigger(v)) return { flags, error: `--trigger must be one of ${TRIGGERS.join("|")}` }; flags.trigger = v; break; }
      case "--tool": flags.tool = next(); break;
      case "--path": flags.pathGlob = next(); break;
      case "--command": flags.command = next() ?? null; break;
      case "--scope": { const v = next(); if (!v || !(SCOPES as readonly string[]).includes(v)) return { flags, error: "--scope must be project|user|global" }; flags.scope = v as Scope; break; }
      case "--timeout": { const v = Number(next()); if (!Number.isFinite(v) || v <= 0) return { flags, error: "--timeout needs a positive number (seconds)" }; flags.timeout = v; break; }
      case "--block": flags.block = true; break;
      case "--modify": flags.modify = true; break;
      case "--no-audit": flags.audit = false; break;
      case "--description": flags.description = next(); break;
      case "-y": case "--yes": flags.force = true; break;
      default: return { flags, error: `unknown /hook add flag "${t}"\n\n${USAGE}` };
    }
    i++;
  }
  if (!flags.trigger) return { flags, error: "--trigger is required\n\n" + USAGE };
  if (!flags.command) return { flags, error: "--command is required\n\n" + USAGE };
  return { flags };
}

/**
 * The in-root script a `/hook add` should scaffold, if the command names one.
 * `bin/gate.js` is run by node — the one interpreter every platform has — so
 * the manifest records `node bin/gate.js` (and the stub is a node script). A
 * POSIX-shaped path like `bin/gate.sh` is kept verbatim: the operator asked
 * for a shell script by name. Either way the path must sit in the hooks root's
 * own `bin/`, which is what makes a relative command safe to run.
 */
export function stubTarget(command: string): { rel: string; node: boolean; line: string } | null {
  const trimmed = command.trim();
  const m = /^(?:node\s+)?(bin\/[^\s]+)$/i.exec(trimmed);
  if (!m) return null;
  const rel = m[1]!;
  const node = /^node\s/i.test(trimmed) || /\.(js|mjs|cjs)$/i.test(rel);
  return { rel, node, line: node ? `node ${rel}` : rel };
}

/** The starting point a scaffolded hook gets: drained stdin, then exit 0. */
export function stubBody(id: string, node: boolean): string {
  const what = "stdin: JSON event; exit 0 = allow, 2 = block (reason on stderr)";
  return node
    ? `#!/usr/bin/env node\n// ${id} hook — ${what}\n` +
        `process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));\n` +
        `process.stdin.on("error", () => process.exit(0));\n`
    : `#!/bin/sh\n# ${id} hook\n# ${what}\ncat >/dev/null\nexit 0\n`;
}

/** /hook add <id> ... — scaffold manifest (+ stub script when in-root). */
export async function hookAdd(tokens: string[], ctx: HookCommandCtx): Promise<string> {
  const { flags, error } = parseAddFlags(tokens, ctx.env);
  if (error) return error;

  const root =
    flags.scope === "project" ? projectHookRoot(ctx.cwd) :
    flags.scope === "user" ? userHookRoot(ctx.home) :
    globalHookRoot(ctx.home);
  const file = path.join(root, `${sanitizeId(flags.id!)}.json`);

  if (fs.existsSync(file) && !flags.force) {
    const ok = ctx.ui.confirm
      ? await ctx.ui.confirm("Overwrite hook?", `${file} already exists — replace it?`)
      : false;
    if (!ok) return `not overwriting existing hook ${flags.id} (use -y to force)`;
  }

  const target = typeof flags.command === "string" ? stubTarget(flags.command) : null;
  const manifest: Record<string, unknown> = {
    id: flags.id,
    trigger: flags.trigger,
  };
  if (flags.tool || flags.pathGlob) {
    manifest.matcher = {
      ...(flags.tool ? { tool: flags.tool } : {}),
      ...(flags.pathGlob ? { path: flags.pathGlob } : {}),
    };
  }
  manifest.command = target ? target.line : flags.command;
  if (flags.timeout !== undefined) manifest.timeout = flags.timeout;
  const on: Record<string, boolean> = {};
  if (flags.block) on.block = true;
  if (flags.modify) on.modify = true;
  if (!flags.audit) on.audit = false;
  if (Object.keys(on).length > 0) manifest.on = on;
  if (flags.description) manifest.description = flags.description;

  const check = validateManifest(manifest);
  if (check) return `invalid hook spec: ${check}`;

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

  // If the command names a script inside the hooks root, scaffold a runnable
  // stub for it (see stubTarget for which language it gets).
  let stub: string | null = null;
  if (target) {
    const binPath = path.join(root, target.rel);
    if (!fs.existsSync(binPath)) {
      fs.mkdirSync(path.dirname(binPath), { recursive: true });
      fs.writeFileSync(binPath, stubBody(flags.id!, target.node), { mode: 0o755 });
      stub = target.rel;
    }
  }

  return `hook ${flags.id} written to ${file} (${fmtScope(flags.scope)}, ${flags.trigger})` +
    (stub ? `\nstub script: ${path.join(root, stub)}` : "");
}

/** /hook test <id> [tool] [jsonArgs] — dry-run without touching the session. */
export async function hookTest(tokens: string[], ctx: HookCommandCtx): Promise<string> {
  const id = tokens[0];
  if (!id) return "usage: /hook test <id> [tool] [jsonArgs]";
  const reg = ctx.engine.registry(ctx.cwd);
  const hook = reg.byId(id);
  if (!hook) return `no effective hook "${id}" — /hook list to see what exists`;
  const tool = tokens[1] ?? (hook.trigger === "UserPromptSubmit" ? "__prompt__" : "write_file");
  let args: Record<string, unknown> = {};
  if (tokens[2]) {
    try {
      const v = JSON.parse(tokens[2]) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) args = v as Record<string, unknown>;
    } catch {
      return `jsonArgs must be a JSON object (got: ${tokens[2]})`;
    }
  }
  const payload =
    hook.trigger === "PreToolUse"
      ? { tool, toolCallId: "test", args, cwd: ctx.cwd }
      : hook.trigger === "PostToolUse"
        ? { tool, toolCallId: "test", args, result: { content: [], details: {}, isError: false }, cwd: ctx.cwd }
        : hook.trigger === "UserPromptSubmit"
          ? { prompt: String(args.prompt ?? "sample prompt for the hook test"), cwd: ctx.cwd }
          : { reason: "test", turnIndex: 0, cwd: ctx.cwd };
  const outcome = await executeHook({ hook, payload, env: ctx.env });
  const head = `hook ${id} (${hook.trigger}) -> ${outcome.status}${outcome.status === "error" && outcome.timedOut ? " (timeout)" : ""} in ${outcome.durationMs}ms`;
  switch (outcome.status) {
    case "block": return `${head}\nreason: ${outcome.reason}`;
    case "error": return `${head}\n${outcome.message}`;
    case "allow":
      return outcome.response
        ? `${head}\nstdout JSON: ${JSON.stringify(outcome.response)}`
        : `${head}\n(no response; treated as allow)`;
  }
}

/** /hook disable <id> — disables the effective copy (persisted). */
export async function hookDisable(tokens: string[], ctx: HookCommandCtx): Promise<string> {
  const id = tokens[0];
  if (!id) return "usage: /hook disable <id>";
  const reg = ctx.engine.registry(ctx.cwd);
  const ref = reg.disable(id);
  if (!ref) return `no effective hook "${id}" — /hook list to see what exists`;
  return `disabled ${ref.key} (${ref.hook.trigger}); use /hook enable ${ref.key} to restore`;
}

/** /hook enable <key> — key is a bare id or scope:id. */
export async function hookEnable(tokens: string[], ctx: HookCommandCtx): Promise<string> {
  const key = tokens[0];
  if (!key) return "usage: /hook enable <id> (or <scope:id>)";
  const reg = ctx.engine.registry(ctx.cwd);
  return reg.enable(key) ? `enabled ${key}` : `nothing disabled for "${key}"`;
}

export function sanitizeId(id: string): string {
  return id.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "hook";
}