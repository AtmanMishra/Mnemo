/**
 * The gate every tool call passes before it runs.
 *
 * Order of authority, first answer wins:
 *   1. rules in `$MNEMO_HOME/permissions.json` (`allow` / `ask` / `deny`, first match)
 *   2. the mode (plan refuses changes; yolo allows the rest)
 *   3. the kind of tool: reading is free, edits and commands ask
 *   4. for commands, grants the user gave earlier ("don't ask again for git status*")
 *
 * The question itself goes to the interface. With no interface (`mnemo -p`) an
 * ask is allowed: headless runs are automation the user started on purpose, and
 * a deny rule is still a deny. The gate filters what runs; it is not a sandbox.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decide } from "../policy/gate.ts";
import type { ApprovalRequest } from "../runtime/dialogs.ts";
import type { Host } from "./host.ts";

const READ = new Set(["read", "grep", "find", "ls", "memory_search", "memory_remember", "memory_steer", "spawn_subagent"]);
const EDIT = new Set(["edit", "write", "create_skill", "update_skill"]);
const EXEC = new Set(["bash", "powershell", "ipy_run"]);

export interface Rule {
  tool: string;
  pattern?: string;
  action: "allow" | "ask" | "deny";
}

interface GrantsFile {
  projects: Record<string, string[]>;
  global: string[];
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function loadRules(home: string): Rule[] {
  const raw = readJson<{ rules?: Rule[] } | Rule[]>(path.join(home, "permissions.json"), []);
  const rules = Array.isArray(raw) ? raw : (raw.rules ?? []);
  return rules.filter((r) => r && typeof r.tool === "string" && ["allow", "ask", "deny"].includes(r.action));
}

/** `*` matches anything; everything else is literal. */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  return re.test(text);
}

/** The argument that makes a call dangerous: the command, the path, the code. */
export function subjectOf(tool: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.code ?? input.pattern ?? input.name ?? "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function matchRule(rules: readonly Rule[], tool: string, subject: string): Rule | undefined {
  return rules.find((r) => globMatch(r.tool, tool) && (r.pattern === undefined || globMatch(r.pattern, subject)));
}

function insideProject(cwd: string, p: unknown): boolean {
  if (typeof p !== "string") return false;
  const rel = path.relative(cwd, path.resolve(cwd, p));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

const TITLES: Record<string, string> = { bash: "Bash", edit: "Edit", write: "Write", ipy_run: "Python", powershell: "PowerShell" };

/** What the approval dialog shows for a call. */
export function approvalPreview(tool: string, input: Record<string, unknown>): ApprovalRequest["preview"] {
  const lines = (s: unknown) => (typeof s === "string" ? s.replace(/\s+$/, "").split("\n") : []);
  if (tool === "edit" && Array.isArray(input.edits)) {
    return (input.edits as { oldText?: string; newText?: string }[]).flatMap((e, i) => [
      ...(i > 0 ? [{ text: "⋯", tone: "muted" as const }] : []),
      ...lines(e.oldText).map((t) => ({ text: `- ${t}`, tone: "remove" as const })),
      ...lines(e.newText).map((t) => ({ text: `+ ${t}`, tone: "add" as const })),
    ]);
  }
  if (tool === "write") return lines(input.content).map((t) => ({ text: `+ ${t}`, tone: "add" as const }));
  if (tool === "ipy_run") return lines(input.code).map((t) => ({ text: t }));
  if (tool === "bash" && typeof input.command === "string" && input.command.includes("\n"))
    return lines(input.command).map((t) => ({ text: t }));
  return [];
}

export class Grants {
  private file: string;
  private data: GrantsFile;

  constructor(home: string) {
    this.file = path.join(home, "grants.json");
    this.data = readJson<GrantsFile>(this.file, { projects: {}, global: [] });
    this.data.projects ??= {};
    this.data.global ??= [];
  }

  for(cwd: string) {
    return { project: this.data.projects[cwd] ?? [], global: this.data.global, deny: [] as string[] };
  }

  add(cwd: string, pattern: string): void {
    const list = (this.data.projects[cwd] ??= []);
    if (!list.includes(pattern)) list.push(pattern);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch {
      // A grant that cannot be saved still holds for this process.
    }
  }
}

export type Verdict = { allow: true } | { allow: false; reason: string } | { ask: ApprovalRequest; pattern?: string };

/** The decision without the question: pure apart from reading `host.mode`. */
export function judge(
  host: Pick<Host, "mode">,
  rules: readonly Rule[],
  grants: ReturnType<Grants["for"]>,
  cwd: string,
  tool: string,
  input: Record<string, unknown>,
): Verdict {
  const subject = subjectOf(tool, input);
  const rule = matchRule(rules, tool, subject);
  if (rule?.action === "deny") return { allow: false, reason: `Refused by a rule in permissions.json (${rule.tool}${rule.pattern ? ` ${rule.pattern}` : ""}).` };
  if (rule?.action === "allow") return { allow: true };
  const kind = READ.has(tool) ? "read" : EDIT.has(tool) ? "edit" : EXEC.has(tool) ? "exec" : "other";
  if (kind !== "read" && host.mode === "plan")
    return { allow: false, reason: "Plan mode is read-only: describe the change instead of making it. The user can leave plan mode with shift+tab." };
  if (rule?.action !== "ask") {
    if (kind === "read" || host.mode === "yolo") return { allow: true };
    const path = input.path;
    if (kind === "edit" && host.mode === "accept-edits" && (path === undefined || insideProject(cwd, path))) return { allow: true };
  }
  const request: ApprovalRequest = {
    tool: TITLES[tool] ?? tool,
    subject: subject.split("\n")[0]!.slice(0, 200),
    preview: approvalPreview(tool, input),
  };
  if (tool === "bash" && rule?.action !== "ask") {
    const g = decide({ toolName: tool, input }, grants);
    if (g.decision === "allow") return { allow: true };
    request.reason = g.reason;
    if (g.offerAlways && g.pattern) {
      request.always = g.pattern;
      return { ask: request, pattern: g.pattern };
    }
  }
  return { ask: request };
}

export function policyExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const grants = new Grants(host.home);
    pi.on("tool_call", async (event, ctx) => {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const verdict = judge(host, loadRules(host.home), grants.for(ctx.cwd), ctx.cwd, event.toolName, input);
      if ("allow" in verdict) return verdict.allow ? undefined : { block: true, reason: verdict.reason };
      if (!host.ui) return undefined;
      const answer = await host.ui.approve(verdict.ask, ctx.signal);
      if (answer.kind === "yes") return undefined;
      if (answer.kind === "always") {
        if (verdict.pattern) grants.add(ctx.cwd, verdict.pattern);
        else if (EDIT.has(event.toolName)) host.mode = "accept-edits";
        return undefined;
      }
      return {
        block: true,
        reason: answer.feedback
          ? `The user declined this call and said: ${answer.feedback}`
          : "The user declined this call. Ask what they would prefer before trying something similar.",
      };
    });
  };
}

