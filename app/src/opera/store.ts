/**
 * Opera: one conductor, several repositories, threads that each work in their own worktree.
 * This file is what lives on disk, all under `$MNEMO_HOME/opera/<name>/` (folders 0700, files 0600):
 *
 *   opera.json          the repositories attached and the Opera's budget (only `mnemo opera` writes it)
 *   repos/<repo>/       a repository cloned with `mnemo opera add <name> <url>`
 *   worktrees/<slug>/   one git worktree per thread, on its own branch `opera/<slug>`
 *   LOG.md              one line per thing a thread or the conductor did, written by the program
 *
 * Only the user attaches, clones or trusts a repository, from the command line; no tool can. The
 * only network use is that clone: an https address the user typed, with git's hooks, filters and
 * submodules off and no global or system git config, as for a skills marketplace.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SAFE_GIT, trustedBin } from "../runtime/bin.ts";
import { baseEnv } from "../runtime/env.ts";
import { parseSource } from "../market/store.ts";

/** Dollars all the threads of one Opera may spend together, unless the user sets another. */
export const DEFAULT_BUDGET = 5;
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

export interface OperaRepo {
  name: string;
  kind: "local" | "clone";
  /** The repository's top folder (real path). */
  path: string;
  /** For a clone: the address it came from. */
  url?: string;
  /** The user said its own `.agents/` resources may load in threads (`--trust`). */
  trusted: boolean;
  added: number;
}

export interface OperaConfig {
  name: string;
  /** Dollars for all threads together; 0 is no limit. */
  budget: number;
  repos: OperaRepo[];
  created: number;
}

export const operaRoot = (home: string): string => path.join(home, "opera");
export const operaDir = (home: string, name: string): string => path.join(operaRoot(home), name);
const configFile = (home: string, name: string) => path.join(operaDir(home, name), "opera.json");

export type Runner = (cmd: string[], cwd: string) => { code: number; out: string; err: string };

/** git with no global or system config (no credential helpers, aliases or url rewrites) and no prompt. */
export const runGit: Runner = (cmd, cwd) => {
  const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
  const p = Bun.spawnSync(cmd, { cwd, env: { ...baseEnv(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull }, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
};

/** `git <args>` in `cwd` with the repository's hooks and fsmonitor off; its output, or an error with git's last line. */
export function git(cwd: string, args: string[], runner: Runner = runGit): string {
  const bin = trustedBin("git");
  if (!bin) throw new Error("git is not installed (or not on PATH)");
  const r = runner([bin, ...SAFE_GIT, ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.err.trim().split("\n").at(-1) || `exit ${r.code}`}`);
  return r.out;
}

function checkName(name: string, what: string): string {
  if (!NAME.test(name)) throw new Error(`${what} "${name}" is not a usable name: letters, digits, '.', '_' and '-', up to 40, starting with a letter or digit`);
  return name;
}

function writeConfig(home: string, cfg: OperaConfig): void {
  const file = configFile(home, cfg.name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createOpera(home: string, name: string, budget = DEFAULT_BUDGET): OperaConfig {
  checkName(name, "an Opera");
  if (fs.existsSync(configFile(home, name))) throw new Error(`there is already an Opera called ${name}`);
  if (!(budget >= 0)) throw new Error("the budget is a number of dollars, 0 for no limit");
  const cfg: OperaConfig = { name, budget, repos: [], created: Date.now() };
  writeConfig(home, cfg);
  return cfg;
}

/** The Opera as the user last set it. A repository entry that is not what `mnemo opera` writes is dropped, not trusted. */
export function readOpera(home: string, name: string): OperaConfig {
  checkName(name, "an Opera");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configFile(home, name), "utf8"));
  } catch {
    throw new Error(`there is no Opera called ${name} (mnemo opera new ${name})`);
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const repos = (Array.isArray(o.repos) ? o.repos : []).filter(
    (r): r is OperaRepo =>
      !!r &&
      typeof r === "object" &&
      typeof r.name === "string" &&
      NAME.test(r.name) &&
      (r.kind === "local" || r.kind === "clone") &&
      typeof r.path === "string" &&
      path.isAbsolute(r.path),
  );
  return {
    name,
    budget: typeof o.budget === "number" && o.budget >= 0 ? o.budget : DEFAULT_BUDGET,
    repos: repos.map((r) => ({ name: r.name, kind: r.kind, path: r.path, url: typeof r.url === "string" ? r.url : undefined, trusted: r.trusted === true, added: typeof r.added === "number" ? r.added : 0 })),
    created: typeof o.created === "number" ? o.created : 0,
  };
}

export function listOperas(home: string): OperaConfig[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(operaRoot(home));
  } catch {
    return [];
  }
  return names.filter((n) => NAME.test(n) && fs.existsSync(configFile(home, n))).sort().map((n) => readOpera(home, n));
}

export function setBudget(home: string, name: string, budget: number): OperaConfig {
  if (!(budget >= 0)) throw new Error("the budget is a number of dollars, 0 for no limit");
  const cfg = { ...readOpera(home, name), budget };
  writeConfig(home, cfg);
  return cfg;
}

/** The arguments of a repository clone: https only, no hooks, no submodules. Its whole history, so threads can branch and merge. */
export function cloneCommand(git: string, url: string, dest: string): string[] {
  return [git, ...SAFE_GIT, "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "clone", "--no-recurse-submodules", "--", url, dest];
}

/**
 * Attach a repository: a folder inside a git repository (its top is attached), or an https
 * address (or owner/repo on GitHub), which is cloned into `repos/`. `trust` lets the repository's
 * own `.agents/` resources load in its threads; a clone is untrusted unless the user says so.
 */
export function addRepo(home: string, opera: string, source: string, o: { name?: string; trust?: boolean; runner?: Runner } = {}): OperaRepo {
  const cfg = readOpera(home, opera);
  const runner = o.runner ?? runGit;
  const src = parseSource(source);
  const base = src.kind === "dir" ? path.basename(src.dir) : path.basename(new URL(src.url).pathname).replace(/\.git$/, "");
  const name = checkName(o.name ?? base, "a repository");
  if (cfg.repos.some((r) => r.name === name)) throw new Error(`${opera} already has a repository called ${name}; give another with --name`);
  let repo: OperaRepo;
  if (src.kind === "dir") {
    let top: string;
    try {
      top = git(src.dir, ["rev-parse", "--show-toplevel"], runner).trim();
    } catch {
      throw new Error(`${src.dir} is not inside a git repository: threads work in git worktrees`);
    }
    repo = { name, kind: "local", path: fs.realpathSync.native(top), trusted: o.trust === true, added: Date.now() };
  } else {
    const bin = trustedBin("git");
    if (!bin) throw new Error("git is not installed (or not on PATH)");
    const reposDir = path.join(operaDir(home, opera), "repos");
    fs.mkdirSync(reposDir, { recursive: true, mode: 0o700 });
    const dest = path.join(reposDir, name);
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists; remove it or give another --name`);
    const staging = path.join(reposDir, `.staging-${name}`);
    fs.rmSync(staging, { recursive: true, force: true });
    const r = runner(cloneCommand(bin, src.url, staging), reposDir);
    if (r.code !== 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`git clone ${src.url} failed: ${r.err.trim().split("\n").at(-1) ?? r.code}. A private repository: clone it yourself and add the folder`);
    }
    fs.renameSync(staging, dest);
    repo = { name, kind: "clone", path: fs.realpathSync.native(dest), url: src.url, trusted: o.trust === true, added: Date.now() };
  }
  writeConfig(home, { ...cfg, repos: [...cfg.repos, repo] });
  return repo;
}

/** Detach a repository. A clone's folder goes too; a folder of yours is left as it is. Worktrees are kept. */
export function removeRepo(home: string, opera: string, name: string): OperaRepo {
  const cfg = readOpera(home, opera);
  const repo = cfg.repos.find((r) => r.name === name);
  if (!repo) throw new Error(`${opera} has no repository called ${name}`);
  writeConfig(home, { ...cfg, repos: cfg.repos.filter((r) => r !== repo) });
  const reposDir = path.join(operaDir(home, opera), "repos");
  // Only ever a folder under repos/: a hand-edited path must not make this delete anything else.
  if (repo.kind === "clone" && fs.existsSync(reposDir) && path.dirname(repo.path) === fs.realpathSync.native(reposDir)) fs.rmSync(repo.path, { recursive: true, force: true });
  return repo;
}
