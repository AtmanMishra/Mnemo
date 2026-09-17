/**
 * `mnemo init` — project-memory bootstrap.
 *
 * Seeding a project's memory with its conventions is a write to a file a human
 * reads and edits, so this command's whole design is one rule: it proposes, and
 * a person disposes. It never overwrites quietly.
 *
 * WHAT IT WRITES, and why this file and not a new one:
 * pi loads ONE context file per directory, the first of
 * `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`
 * (`loadContextFileFromDir` in the vendored pi dist, and
 * `docs/quickstart.md` §"Give pi project instructions"). Mnemo inherits that
 * loader, and this repository already treats `AGENTS.md` as the agent contract
 * (`docs/MNEMO.md` §9). A `MNEMO.md` nothing reads would be a file that looks
 * like memory and is not, so the target is the file pi actually loads — and if
 * one is already there, THAT is the file this command edits.
 *
 * HOW A WRITE GETS CONSENT:
 * - a `deny` rule for `write_file` on this path blocks it with no prompt, read
 *   through the same `src/permissions.ts` as every tool call (a deny that held
 *   only inside a session would be theatre);
 * - otherwise the question goes through the same consent mapping the
 *   approval-gate uses (`readConsent`), with a confirm-only UI: yes is "once",
 *   no is "no", and an unanswered question is not consent (`--yes` is the
 *   operator stating consent in the command they typed; a non-TTY run without
 *   it refuses).
 * Deliberately NOT used: the gate's force-approve hatch. When
 * `MNEMO_APPROVAL_MODE` is unset the gate allows a gated call with no prompt —
 * right for automation, wrong for the one file the user wrote by hand.
 *
 * The generated part is a marked block, so a second run refreshes it in place
 * instead of growing the file, and a human's own prose is never touched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadScopedPermissions, resolveAction, subjectOf } from "./permissions.ts";
import { readConsent, type ConfirmUI } from "../extensions/approval-gate.ts";

/**
 * pi's context-file candidates, in pi's own order. One file per directory is
 * loaded: the first that exists wins, so `AGENTS.override.md` beats `AGENTS.md`
 * and an existing `CLAUDE.md` beats nothing at all.
 */
export const CONTEXT_FILE_CANDIDATES: readonly string[] = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
];

/** The file a fresh project gets. */
export const DEFAULT_MEMORY_FILE = "AGENTS.md";

export const BLOCK_START = "<!-- mnemo:init:start";
export const BLOCK_END = "<!-- mnemo:init:end -->";

export interface InitOptions {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  log: (s: string) => void;
  err: (s: string) => void;
  /** One consent question, answered by the operator. Injectable for tests. */
  ask?: (question: string) => Promise<string>;
}

export interface Command {
  /** What to type. */
  command: string;
  /** The file it was read from — never an invented runner. */
  source: string;
}

export interface DirEntry {
  name: string;
  /** Only set when a fact in the directory says what it is. */
  note?: string;
}

export interface RepoFacts {
  root: string;
  name?: string;
  description?: string;
  /** Manifests found, by relative path. */
  manifests: string[];
  commands: Command[];
  layout: DirEntry[];
  /** Docs a person wrote, by relative path (README, docs/*.md …). */
  docs: string[];
  /** Workflow names from .github/workflows. */
  workflows: string[];
  /** A CONTRIBUTING/CONVENTIONS file whose rules are the project's own. */
  conventionsFile?: string;
  /** True when this directory is inside a git repository. */
  git: boolean;
}

// --- reading the repository -------------------------------------------------

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(file: string): any | undefined {
  const raw = readText(file);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Directories a memory file has no business describing. */
const NOISE_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "target", "dist", "build", "out",
  "coverage", ".next", ".nuxt", ".cache", "__pycache__", ".venv", "venv",
  ".local", ".idea", ".vscode",
]);

const DIR_NOTES: Record<string, string> = {
  src: "source",
  lib: "source",
  app: "application code",
  pkg: "package source",
  cmd: "entry points",
  test: "tests",
  tests: "tests",
  spec: "tests",
  docs: "documentation",
  doc: "documentation",
  scripts: "scripts",
  examples: "examples",
  internal: "internal packages",
  migrations: "database migrations",
  assets: "assets",
  ui: "interface code",
  web: "web code",
};

/**
 * Walk up for the project root: the nearest ancestor holding `.git` (a file in
 * a worktree, a directory in a normal checkout). Pure fs — no `git` process, so
 * this works in a bare temp directory and in a test.
 */
export function findProjectRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(cwd);
    dir = up;
  }
}

/** `.github/workflows/*.yml|yaml` → the workflow names, from `name:` or the file. */
function readWorkflows(root: string): string[] {
  const dir = path.join(root, ".github", "workflows");
  if (!isDir(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const f of entries) {
    if (!/\.ya?ml$/i.test(f)) continue;
    const raw = readText(path.join(dir, f)) ?? "";
    const m = raw.match(/^\s*name:\s*(.+?)\s*$/m);
    names.push(m?.[1] ? m[1].replace(/^["']|["']$/g, "") : f);
  }
  return names;
}

/** Every top-level directory, with a note only where something says what it is. */
function readLayout(root: string): DirEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DirEntry[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    if (NOISE_DIRS.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    const note = DIR_NOTES[e.name]
      ?? (isFile(path.join(dir, "go.mod")) ? "Go module"
        : isFile(path.join(dir, "Cargo.toml")) ? "Rust crate"
          : isFile(path.join(dir, "package.json")) ? "Node package"
            : undefined);
    out.push(note ? { name: e.name, note } : { name: e.name });
  }
  return out;
}

/**
 * The commands a person can actually run, each read from a manifest that
 * exists. Nothing here is a plausible guess: a command whose source file is
 * absent never appears, because a memory file that teaches invented commands is
 * worse than one that says nothing.
 */
function readCommands(root: string, facts: { hasPyTests: boolean }): Command[] {
  const cmds: Command[] = [];
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    const pm = typeof pkg.packageManager === "string" && pkg.packageManager
      ? String(pkg.packageManager).split("@")[0]
      : "npm";
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    for (const name of ["test", "typecheck", "lint", "build", "start", "dev"]) {
      if (typeof scripts[name] === "string") {
        cmds.push({ command: `${pm} run ${name}`, source: "package.json scripts" });
      }
    }
  }
  if (isFile(path.join(root, "go.mod"))) {
    cmds.push({ command: "go test ./...", source: "go.mod" });
    cmds.push({ command: "go build ./...", source: "go.mod" });
    cmds.push({ command: "go vet ./...", source: "go.mod" });
  }
  if (isFile(path.join(root, "Cargo.toml"))) {
    cmds.push({ command: "cargo test", source: "Cargo.toml" });
    cmds.push({ command: "cargo build", source: "Cargo.toml" });
  }
  if (facts.hasPyTests) {
    cmds.push({ command: "python -m pytest", source: "tests/ or a pytest config" });
  }
  // A "same as CI" entry point is a fact about a file, not a convention.
  for (const [file, run] of [["scripts/ci.mjs", "node scripts/ci.mjs"], ["scripts/ci.js", "node scripts/ci.js"]] as const) {
    if (isFile(path.join(root, file))) {
      cmds.push({ command: run, source: file });
      break;
    }
  }
  const makefile = ["Makefile", "makefile"].find((f) => isFile(path.join(root, f)));
  if (makefile) {
    const raw = readText(path.join(root, makefile)) ?? "";
    const targets = [...raw.matchAll(/^([A-Za-z][A-Za-z0-9_.-]*):/gm)].map((m) => m[1]!);
    for (const t of [...new Set(targets)].slice(0, 8)) {
      cmds.push({ command: `make ${t}`, source: makefile });
    }
  }
  return cmds;
}

/** What is actually in this repository. Facts only; no probing of the network. */
export function detectRepoFacts(root: string): RepoFacts {
  root = path.resolve(root);
  const manifests: string[] = [];
  for (const f of [
    "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt",
    "Makefile", "makefile", "tsconfig.json", "composer.json", "Gemfile", "pom.xml",
  ]) {
    if (isFile(path.join(root, f))) manifests.push(f);
  }
  const pySignal = isFile(path.join(root, "pyproject.toml"))
    || isFile(path.join(root, "setup.py"))
    || isFile(path.join(root, "requirements.txt"));
  const hasPyTests =
    (pySignal && (isDir(path.join(root, "tests")) || isDir(path.join(root, "test"))))
    || Boolean(readText(path.join(root, "pyproject.toml"))?.includes("pytest"))
    || isFile(path.join(root, "pytest.ini"));

  const pkg = readJson(path.join(root, "package.json"));
  const goMod = readText(path.join(root, "go.mod"));
  const name = (pkg?.name as string | undefined)
    ?? goMod?.match(/^module\s+(\S+)/m)?.[1]?.split("/").pop()
    ?? path.basename(root);
  const description = typeof pkg?.description === "string" ? pkg.description : undefined;

  const docs: string[] = [];
  for (const f of ["README.md", "README", "CONTRIBUTING.md", "CONVENTIONS.md", "ARCHITECTURE.md"]) {
    if (isFile(path.join(root, f))) docs.push(f);
  }
  const docsDir = path.join(root, "docs");
  if (isDir(docsDir)) {
    try {
      const n = fs.readdirSync(docsDir).filter((f) => /\.md$/i.test(f)).length;
      if (n > 0) docs.push(`docs/ (${n} markdown file${n === 1 ? "" : "s"})`);
    } catch { /* unreadable docs dir is not a fact worth failing over */ }
  }
  const conventionsFile = ["CONTRIBUTING.md", "CONVENTIONS.md", ".github/CONTRIBUTING.md"]
    .find((f) => isFile(path.join(root, f)));

  return {
    root,
    name,
    description,
    manifests,
    commands: readCommands(root, { hasPyTests }),
    layout: readLayout(root),
    docs,
    workflows: readWorkflows(root),
    conventionsFile,
    git: fs.existsSync(path.join(root, ".git")),
  };
}

// --- proposing the file -----------------------------------------------------

/** The generated sections. Everything in here comes from `detectRepoFacts`. */
function blockBody(facts: RepoFacts, forNewFile: boolean): string {
  const out: string[] = [];
  out.push(BLOCK_START + " — generated from this repository by `mnemo init`.");
  out.push("     Everything between the markers is rewritten the next time it runs.");
  out.push("     Your own prose — above and below — is never touched. -->");
  out.push("");
  if (forNewFile) {
    out.push(`# ${DEFAULT_MEMORY_FILE}`);
    out.push("");
    out.push(
      "The file pi loads at startup for instructions in this project (Mnemo reads it too).",
    );
    out.push("");
  }
  out.push(`## This repository`);
  out.push("");
  const what = facts.description ? `${facts.name} — ${facts.description}` : facts.name;
  out.push(what ? `${what}.` : `(no manifest named this project).`);
  if (facts.manifests.length > 0) {
    out.push(`Manifests present: ${facts.manifests.map((m) => `\`${m}\``).join(", ")}.`);
  }
  out.push("");

  if (facts.commands.length > 0) {
    out.push("## Running and checking it");
    out.push("");
    out.push("| Command | Where it comes from |");
    out.push("|---|---|");
    for (const c of facts.commands) out.push(`| \`${c.command}\` | ${c.source} |`);
    out.push("");
    out.push(
      "A change is not finished until the checks that apply to it have been run, " +
        "not merely reasoned about.",
    );
    out.push("");
  }

  if (facts.layout.length > 0) {
    out.push("## Layout");
    out.push("");
    for (const d of facts.layout) out.push(d.note ? `- \`${d.name}/\` — ${d.note}` : `- \`${d.name}/\``);
    out.push("");
  }

  if (facts.workflows.length > 0) {
    out.push("## CI");
    out.push("");
    out.push(
      `.github/workflows/ defines ${facts.workflows.length} workflow${facts.workflows.length === 1 ? "" : "s"}: ` +
        `${facts.workflows.map((w) => `\`${w}\``).join(", ")}. A local green is only trustworthy ` +
        `when it is the same command CI runs.`,
    );
    out.push("");
  }

  if (facts.docs.length > 0) {
    out.push("## The project's own words");
    out.push("");
    out.push(`${facts.docs.map((d) => `\`${d}\``).join(", ")} — read them before assuming.`);
    out.push("");
  }

  out.push("## Conventions");
  out.push("");
  if (facts.conventionsFile) {
    out.push(`\`${facts.conventionsFile}\` states this project's rules. They win over habit.`);
  } else {
    out.push(
      "<!-- No file in this repository states its conventions yet. Write them here:",
    );
    out.push("     they are the part of this file an agent needs most. -->");
    out.push("");
    out.push("- (nothing recorded yet)");
  }
  out.push("");
  out.push(BLOCK_END);
  return out.join("\n");
}

/** The complete file for a project that has none. */
export function renderProjectMemory(facts: RepoFacts): string {
  return blockBody(facts, true) + "\n";
}

/** The marked block, for a file that already exists and may hold a human's prose. */
export function renderBlock(facts: RepoFacts): string {
  return blockBody(facts, false) + "\n";
}

/**
 * Replace the marked block in place, or append it. A second run therefore
 * refreshes the generated part instead of growing the file forever, and no line
 * a person wrote is ever removed or reordered.
 */
export function upsertBlock(existing: string, block: string): string {
  const start = existing.indexOf(BLOCK_START);
  const endMarker = existing.lastIndexOf(BLOCK_END);
  const blockText = block.endsWith("\n") ? block : block + "\n";
  if (start >= 0 && endMarker > start) {
    const after = existing.slice(endMarker + BLOCK_END.length);
    // One newline after the marker: the file's own trailing whitespace is none
    // of our business, but a duplicated blank line from a refresh is.
    const rest = after.replace(/^\n/, "");
    return existing.slice(0, start) + blockText + rest;
  }
  const base = existing.length === 0 || existing.endsWith("\n") ? existing : existing + "\n";
  return base + "\n" + blockText;
}

// --- the diff a person is asked to approve ---------------------------------

const MAX_DIFF_LINES = 2000;

/** Longest common subsequence of two line arrays, as opcodes. */
function diffOps(a: string[], b: string[]): Array<["=" | "-" | "+", string]> {
  const n = a.length;
  const m = b.length;
  // Small files: a plain DP table is exact and obvious. Big ones: say so rather
  // than freeze — a proposal nobody can be shown is a proposal nobody approved.
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) return [];
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + (j + 1)]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + (j + 1)]!);
    }
  }
  const ops: Array<["=" | "-" | "+", string]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(["=", a[i]!]);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + (j + 1)]!) {
      ops.push(["-", a[i]!]);
      i++;
    } else {
      ops.push(["+", b[j]!]);
      j++;
    }
  }
  while (i < n) ops.push(["-", a[i++]!]);
  while (j < m) ops.push(["+", b[j++]!]);
  return ops;
}

/**
 * A unified diff — the thing a person reads before answering a consent prompt.
 * Not a summary: a summary of a change to a file someone wrote is the change
 * "in my words", and consent to my words is not consent to the edit.
 */
export function unifiedDiff(before: string, after: string, label: string, context = 3): string {
  const a = before.length > 0 ? before.replace(/\n$/, "").split("\n") : [];
  const b = after.length > 0 ? after.replace(/\n$/, "").split("\n") : [];
  const ops = diffOps(a, b);
  if (ops.length === 0) {
    return `(diff not shown: ${a.length} → ${b.length} lines is too large to render here)`;
  }
  if (ops.every(([k]) => k === "=")) return ""; // identical

  // Hunk grouping: a run of changes with `context` lines of unchanged text
  // either side, merged when two changes are closer than twice the context.
  const hunks: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]![0] === "=") continue;
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && from <= last.end) last.end = Math.max(last.end, to);
    else hunks.push({ start: from, end: to });
  }

  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let aLine = 1;
  let bLine = 1;
  let cursor = 0;
  for (const h of hunks) {
    // Advance the counters past what we skipped.
    for (let i = cursor; i < h.start; i++) {
      if (ops[i]![0] !== "+") aLine++;
      if (ops[i]![0] !== "-") bLine++;
    }
    let aCount = 0;
    let bCount = 0;
    for (let i = h.start; i < h.end; i++) {
      if (ops[i]![0] !== "+") aCount++;
      if (ops[i]![0] !== "-") bCount++;
    }
    out.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (let i = h.start; i < h.end; i++) {
      const [kind, line] = ops[i]!;
      out.push(kind === "=" ? ` ${line}` : kind === "-" ? `-${line}` : `+${line}`);
    }
    cursor = h.end;
    aLine += aCount;
    bLine += bCount;
  }
  return out.join("\n");
}

// --- finding the file pi will actually load ---------------------------------

export interface MemoryTarget {
  /** Path relative to the project root, as it appears in the diff. */
  relative: string;
  absolute: string;
  exists: boolean;
}

/**
 * The existing file pi loads for this directory, else the one to create. A file
 * that is already there is the target even when it is `CLAUDE.md`: pi loads it,
 * so it is this project's memory, and writing a second file beside it would
 * leave the agent reading the one nobody updated.
 */
export function findMemoryTarget(root: string, explicit?: string): MemoryTarget {
  if (explicit) {
    const absolute = path.resolve(root, explicit);
    return { relative: path.relative(root, absolute) || path.basename(absolute), absolute, exists: isFile(absolute) };
  }
  for (const candidate of CONTEXT_FILE_CANDIDATES) {
    const absolute = path.join(root, candidate);
    if (isFile(absolute)) return { relative: candidate, absolute, exists: true };
  }
  const absolute = path.join(root, DEFAULT_MEMORY_FILE);
  return { relative: DEFAULT_MEMORY_FILE, absolute, exists: false };
}

/** The consent question, asked on the terminal. Empty answer = no consent. */
export function defaultAsk(): (question: string) => Promise<string> {
  return async (question: string) => {
    // No TTY: nobody can answer, and an unanswered question is not consent.
    if (!process.stdin.isTTY) return "";
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
}

function usage(o: InitOptions): void {
  o.err(
    "usage: mnemo init [--dry-run] [--yes] [--target <file>]\n" +
      "  proposes the project-memory file pi loads (AGENTS.md, or the one already there)\n" +
      "  --dry-run  show the proposal and the diff, write nothing\n" +
      "  --yes      consent on the command line instead of at the prompt\n" +
      "  --target   write somewhere other than the file pi loads",
  );
}

/**
 * `mnemo init [--dry-run] [--yes] [--target FILE]` → the process exit code.
 * 0 written / already up to date / dry run · 1 refused · 2 usage.
 */
export async function runInit(args: string[], o: InitOptions): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const targetIdx = args.indexOf("--target");
  const explicit = targetIdx >= 0 ? args[targetIdx + 1] : undefined;
  const known = new Set(["--dry-run", "--yes", "--target", explicit].filter(Boolean) as string[]);
  const unknown = args.find((a) => !known.has(a));
  if (unknown || (targetIdx >= 0 && !explicit)) {
    o.err(`init: unknown argument ${unknown ? `"${unknown}"` : "(--target needs a file)"}`);
    usage(o);
    return 2;
  }

  const root = findProjectRoot(o.cwd);
  const facts = detectRepoFacts(root);
  const target = findMemoryTarget(root, explicit);
  const block = renderBlock(facts);

  const existing = target.exists ? (readText(target.absolute) ?? "") : undefined;
  const proposed = existing === undefined ? renderProjectMemory(facts) : upsertBlock(existing, block);
  const changed = existing === undefined || proposed !== existing;

  o.log(
    existing === undefined
      ? `init: ${target.relative} — new file (pi loads this at startup; nothing is overwritten)`
      : `init: ${target.relative} — exists (${existing.split("\n").length} lines); the generated block would be ${
        existing.includes(BLOCK_START) ? "refreshed in place" : "appended, leaving your text untouched"
      }`,
  );
  if (!facts.git) o.log(`init: ${root} is not a git repository (still writing here)`);
  if (!target.exists && facts.layout.length > 0) {
    o.log(`init: read ${facts.manifests.join(", ") || "no manifest"} and ${facts.layout.length} top-level director${facts.layout.length === 1 ? "y" : "ies"}`);
  }

  if (!changed) {
    o.log(`init: ${target.relative} is already up to date — nothing written`);
    return 0;
  }

  // Show the change itself, before any question: a prompt about a file the
  // person cannot see is a prompt that cannot be answered.
  const diff = existing === undefined
    ? ""
    : unifiedDiff(existing, proposed, target.relative);
  if (existing === undefined) {
    o.log("\n" + proposed.replace(/\n$/, ""));
  } else {
    o.log("\n" + (diff || "(no textual difference)"));
  }

  if (dryRun) {
    o.log(`\ninit: --dry-run — nothing written`);
    return 0;
  }

  // A deny rule is a decision the operator already made; it holds here with no
  // prompt, exactly as it does for a tool call. `|| undefined` keeps
  // permissions.ts' own default (the real home) when a caller has none to give.
  const perms = loadScopedPermissions(o.cwd, o.home || undefined);
  const action = resolveAction(perms, "write_file", { path: target.absolute });
  if (action === "deny") {
    o.err(
      `init: refused — a deny rule covers write_file ${subjectOf("write_file", { path: target.absolute })} ` +
        `(remove it from .mnemo/permissions.json or ~/.mnemo/permissions.json to allow this)`,
    );
    return 1;
  }

  if (existing !== undefined && !yes) {
    const ask = o.ask ?? defaultAsk();
    const ui: ConfirmUI = {
      // Confirm-only, deliberately: readConsent maps a y/n to allow-once or
      // deny and never to a remembered grant, because "yes" cannot express a
      // scope. The grant options belong in the dialog, not in a CLI flag.
      confirm: async (title, detail) => {
        const answer = (await ask(`\n${title}\n${detail}\n[y]es / [n]o: `)).toLowerCase();
        return answer === "y" || answer === "yes";
      },
    };
    const outcome = await readConsent(ui, "write_file", target.relative, {
      path: target.absolute,
      content: proposed,
    });
    if (outcome.kind !== "once") {
      o.err(`init: nothing written — no consent for ${target.relative}`);
      return 1;
    }
  } else if (existing !== undefined) {
    o.log(`init: --yes given — writing without a prompt`);
  }

  writeAtomic(target.absolute, proposed);
  o.log(`init: wrote ${target.relative} (${proposed.split("\n").length - 1} lines)`);
  o.log(`init: pi loads it at startup — restart pi, or run /reload, for a running session to see it`);
  return 0;
}

/** Beside-then-rename: a reader never sees a half-written memory file. */
function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}
