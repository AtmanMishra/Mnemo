/**
 * The conductor's side of an Opera while it runs: the threads it started (each a background
 * sub-agent in its own worktree), the Opera's budget across all of them, and LOG.md, the record of
 * what every thread did. One per conductor session; its sub-agents share it through the host.
 *
 * Everything a thread writes is model-authored: lines are cleaned and redacted (roster.ts `clean`)
 * before they reach the file or the conductor, and the conductor reads them as data.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { clean, isEnded, type Roster, type RosterEvent, type RosterNode } from "../runtime/roster.ts";
import { projectTrusted } from "../runtime/runtime.ts";
import { git, operaDir, runGit, type OperaConfig, type OperaRepo, type Runner } from "./store.ts";

export interface Thread {
  /** Its node in the roster. */
  node: number;
  repo: string;
  /** Its worktree and branch, and the commit both started from. */
  dir: string;
  branch: string;
  base: string;
  startedAt: number;
}

/** A worktree made for a thread that is about to start. */
export interface Prepared {
  repo: OperaRepo;
  dir: string;
  branch: string;
  base: string;
  trusted: boolean;
}

/** LOG.md lines the conductor keeps in memory for `thread_list` (the file keeps all of them). */
const KEEP = 400;

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "thread";

export class Conductor {
  readonly dir: string;
  readonly threads = new Map<number, Thread>();
  private lines: { node?: number; line: string }[] = [];
  private seen = new WeakSet<RosterEvent>();
  private tripped = false;

  constructor(
    readonly home: string,
    readonly opera: OperaConfig,
    private readonly roster: Roster,
    /** The conductor's own node (the root the user talks to). */
    readonly root: number,
    private readonly o: { agentDir: string; runner?: Runner; now?: () => number },
  ) {
    this.dir = operaDir(home, opera.name);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const e of roster.snapshot().events) this.seen.add(e);
    roster.subscribe(() => this.watch());
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  repo(name: string): OperaRepo {
    const r = this.opera.repos.find((x) => x.name === name);
    if (!r) throw new Error(`no repository ${name} in this Opera; there ${this.opera.repos.length === 1 ? "is" : "are"} ${this.opera.repos.map((x) => x.name).join(", ") || "none (the user attaches them with mnemo opera add)"}`);
    return r;
  }

  /** The thread `id` belongs to: its own, or that of the thread it is a sub-agent of. */
  threadOf(id: number): Thread | undefined {
    for (let n: RosterNode | undefined = this.roster.get(id); n; n = n.parent === undefined ? undefined : this.roster.get(n.parent)) {
      const t = this.threads.get(n.id);
      if (t) return t;
    }
    return undefined;
  }

  /** Dollars every thread (and the sub-agents they started) spent. */
  spent(): number {
    let usd = 0;
    for (const t of this.threads.values()) for (const n of [this.roster.get(t.node), ...this.roster.descendants(t.node)]) usd += n?.spent ?? 0;
    return usd;
  }

  /** Why no thread may start now, if one may not. */
  refusal(): string | undefined {
    const b = this.opera.budget;
    if (b > 0 && this.spent() >= b) return `the Opera has spent its budget of $${b.toFixed(2)}; the user raises it with mnemo opera budget ${this.opera.name} <dollars>`;
    return undefined;
  }

  /** A worktree on a new branch for a thread in `repoName`, from the repository's HEAD. Its working tree is not touched. */
  prepare(repoName: string, label: string): Prepared {
    const repo = this.repo(repoName);
    if (!fs.existsSync(repo.path)) throw new Error(`${repo.name} is gone from ${repo.path}`);
    const runner = this.o.runner ?? runGit;
    let base: string;
    try {
      base = git(repo.path, ["rev-parse", "HEAD"], runner).trim();
    } catch {
      throw new Error(`${repo.name} has no commit yet to start a thread from`);
    }
    const trees = path.join(this.dir, "worktrees");
    fs.mkdirSync(trees, { recursive: true, mode: 0o700 });
    const stem = `${repo.name}-${slugOf(label)}`;
    let slug = stem;
    for (let i = 2; fs.existsSync(path.join(trees, slug)) || branchExists(repo.path, `opera/${this.opera.name}/${slug}`, runner); i++) slug = `${stem}-${i}`;
    const dir = path.join(trees, slug);
    const branch = `opera/${this.opera.name}/${slug}`;
    git(repo.path, ["worktree", "add", "--quiet", "-b", branch, dir, base], runner);
    return { repo, dir: fs.realpathSync.native(dir), branch, base, trusted: repoTrusted(repo, this.o.agentDir) };
  }

  /** The thread started: from here its actions go in the log under its repository's name. */
  adopt(node: number, p: Prepared): Thread {
    const t: Thread = { node, repo: p.repo.name, dir: p.dir, branch: p.branch, base: p.base, startedAt: this.now };
    this.threads.set(node, t);
    return t;
  }

  /** One line of record: `2026-10-28 14:32 #3 [api] ran bun test — failed`. */
  log(id: number, what: string): void {
    const t = this.threadOf(id);
    const at = new Date(this.now).toISOString().replace("T", " ").slice(0, 16);
    const line = clean(`${at} #${id}${t ? ` [${t.repo}]` : id === this.root ? " [conductor]" : ""} ${what.replace(/\s+/g, " ")}`, 300);
    this.lines = [...this.lines, { node: t?.node, line }].slice(-KEEP);
    try {
      fs.appendFileSync(path.join(this.dir, "LOG.md"), `${line}\n`, { mode: 0o600 });
    } catch {
      /* a full disk must not stop the threads */
    }
  }

  /** The newest log lines, of one thread or of all. */
  tail(n: number, thread?: number): string[] {
    return this.lines.filter((l) => thread === undefined || l.node === thread).slice(-n).map((l) => l.line);
  }

  /** `+40 -2 in 3 files, 1 commit, 2 untracked`: what a thread changed on its branch so far. */
  changes(t: Thread): string {
    const runner = this.o.runner ?? runGit;
    try {
      const stat = git(t.dir, ["diff", "--shortstat", t.base], runner).trim();
      const commits = Number(git(t.dir, ["rev-list", "--count", `${t.base}..HEAD`], runner).trim()) || 0;
      const untracked = git(t.dir, ["ls-files", "--others", "--exclude-standard"], runner).split("\n").filter(Boolean).length;
      const parts = [stat || "no change to tracked files"];
      if (commits) parts.push(`${commits} commit${commits === 1 ? "" : "s"}`);
      if (untracked) parts.push(`${untracked} untracked`);
      return parts.join(", ");
    } catch (e) {
      return `(could not read its worktree: ${e instanceof Error ? e.message : String(e)})`;
    }
  }

  /** What the roster did to the conductor's tree, in the log; and the Opera's budget, held. */
  private watch(): void {
    const events = this.roster.snapshot().events;
    let from = events.length;
    while (from > 0 && !this.seen.has(events[from - 1]!)) from--;
    const mine = (id: number) => id === this.root || !!this.threadOf(id);
    for (const e of events.slice(from)) {
      this.seen.add(e);
      const said = (s: string | undefined) => (s ? `: ${s.replace(/\s+/g, " ").slice(0, 160)}` : "");
      if (e.kind === "spawn" && mine(e.parent)) this.log(e.parent, `started #${e.node} "${this.roster.get(e.node)?.label ?? ""}"${said(this.roster.get(e.node)?.task)}`);
      else if ((e.kind === "done" || e.kind === "failed" || e.kind === "stopped") && mine(e.node))
        this.log(e.node, e.kind === "done" ? `finished${said(this.roster.get(e.node)?.answer)}` : e.kind);
      else if (e.kind === "message" && (mine(e.from) || mine(e.to))) this.log(e.from, `messaged #${e.to}${said(e.text)}`);
      else if (e.kind === "told" && mine(e.node)) this.log(e.node, `was told by the user${said(e.text)}`);
    }
    const b = this.opera.budget;
    if (!this.tripped && b > 0 && this.spent() >= b) {
      this.tripped = true;
      const live = [...this.threads.values()].filter((t) => !isEnded(this.roster.get(t.node)?.status ?? "stopped"));
      this.log(this.root, `the Opera's budget of $${b.toFixed(2)} is spent: stopping ${live.length} thread${live.length === 1 ? "" : "s"}`);
      for (const t of live) this.roster.stopTree(t.node);
    }
  }
}

function branchExists(repo: string, branch: string, runner: Runner): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], runner);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a thread in this repository may load its `.agents/` resources: a clone only when the
 * user said `--trust`; a folder of yours also when you trusted it in a session there.
 */
export function repoTrusted(repo: OperaRepo, agentDir: string): boolean {
  if (repo.trusted) return true;
  return repo.kind === "local" && projectTrusted(repo.path, agentDir);
}
