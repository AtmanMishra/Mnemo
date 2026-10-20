/**
 * Marketplaces and the skills installed from them, all under `$MNEMO_HOME/market/`:
 *
 *   marketplaces.json        name → where it came from and the commit that was read
 *   installed.json           plugin@marketplace → each skill's files with their SHA-256
 *   clones/<name>/           the marketplace as plain files (its .git is dropped)
 *   skills/<marketplace>/<plugin>/<skill>/   what was installed: plain files, folders 0700, files 0600
 *
 * The only network use is `git clone` of an address the user typed in a `mnemo skills marketplace`
 * command, over https, with the repository's own hooks and filters switched off. Nothing runs at
 * install or at load: a skill is text the model reads. A skill loads only while every file under
 * it is exactly what was installed (same bytes, nothing added, no links), checked as each session
 * starts; Claude Code trusts a clone as it is, this also notices a file changed afterwards.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { trustedBin, SAFE_GIT } from "../runtime/bin.ts";
import { baseEnv } from "../runtime/env.ts";
import { NAME, readMarketplace, type Plugin } from "./marketplace.ts";

const MAX_FILES = 300;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CLONE_BYTES = 100 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules"]);

export interface MarketRecord {
  source: string;
  commit?: string;
  added: number;
}

export interface InstalledRecord {
  marketplace: string;
  plugin: string;
  commit?: string;
  installed: number;
  /** skill name → file (relative, `/`) → SHA-256 */
  skills: Record<string, Record<string, string>>;
}

export const marketRoot = (home: string): string => path.join(home, "market");
const clonesDir = (home: string, name?: string) => path.join(marketRoot(home), "clones", ...(name ? [name] : []));
export const skillDir = (home: string, marketplace: string, plugin: string, skill?: string): string => path.join(marketRoot(home), "skills", marketplace, plugin, ...(skill ? [skill] : []));

const sha256 = (b: Uint8Array | string) => crypto.createHash("sha256").update(b).digest("hex");

function readJson<T>(file: string): Record<string, T> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const readMarkets = (home: string) => readJson<MarketRecord>(path.join(marketRoot(home), "marketplaces.json"));
export const readInstalled = (home: string) => readJson<InstalledRecord>(path.join(marketRoot(home), "installed.json"));
const writeMarkets = (home: string, v: Record<string, MarketRecord>) => writeJson(path.join(marketRoot(home), "marketplaces.json"), v);
const writeInstalled = (home: string, v: Record<string, InstalledRecord>) => writeJson(path.join(marketRoot(home), "installed.json"), v);

// ── where a marketplace comes from ──────────────────────────────────────────

/** What the user typed, as an https address git may clone, or a folder to copy. */
export function parseSource(text: string): { kind: "git"; url: string } | { kind: "dir"; dir: string } {
  const s = text.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s) && !fs.existsSync(s)) return { kind: "git", url: `https://github.com/${s.replace(/\.git$/, "")}.git` };
  if (/^https:\/\//i.test(s)) {
    const u = new URL(s);
    if (u.username || u.password) throw new Error("an address with a password in it is not used: let git ask for credentials some other way, or clone it yourself and add the folder");
    return { kind: "git", url: u.href };
  }
  if (/^(http|ssh|git|file|ftp):|^git@/i.test(s)) throw new Error("only an https:// address, owner/repo (on GitHub) or a folder is accepted");
  const dir = path.resolve(s);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${s} is not a folder, an https address or owner/repo`);
  return { kind: "dir", dir };
}

export type Runner = (cmd: string[], cwd: string) => { code: number; out: string; err: string };

const run: Runner = (cmd, cwd) => {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...baseEnv(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
};

/** The arguments of the clone: https only, no hooks, no submodules, one commit deep. */
export function cloneCommand(git: string, url: string, dest: string): string[] {
  return [git, ...SAFE_GIT, "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "clone", "--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules", "--", url, dest];
}

/** Plain files only, and not too many or too big. Returns the byte count. */
function copyTree(from: string, to: string, limit: number, counts = { files: 0, bytes: 0 }): number {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const src = path.join(from, e.name);
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) continue;
    if (st.isDirectory()) copyTree(src, path.join(to, e.name), limit, counts);
    else {
      if (++counts.files > MAX_FILES * 20 || (counts.bytes += st.size) > limit) throw new Error(`it is larger than ${Math.round(limit / 1024 / 1024)} MB or has too many files`);
      fs.writeFileSync(path.join(to, e.name), fs.readFileSync(src), { mode: 0o600 });
    }
  }
  return counts.bytes;
}

function commitOf(dir: string, git: string | undefined): string | undefined {
  if (!git || !fs.existsSync(path.join(dir, ".git"))) return undefined;
  const r = run([git, ...SAFE_GIT, "rev-parse", "HEAD"], dir);
  return r.code === 0 ? r.out.trim() : undefined;
}

/** Bring a marketplace's files to `dest` (plain files), with the commit they are at. */
export function fetchSource(source: string, dest: string, runner: Runner = run): string | undefined {
  const src = parseSource(source);
  if (src.kind === "dir") {
    copyTree(src.dir, dest, MAX_CLONE_BYTES);
    return commitOf(src.dir, trustedBin("git"));
  }
  const git = trustedBin("git");
  if (!git) throw new Error("git is not installed (or not on PATH): install it, or clone the repository yourself and add the folder");
  const staging = `${dest}.git`;
  const r = runner(cloneCommand(git, src.url, staging), path.dirname(dest));
  if (r.code !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`git clone ${src.url} failed: ${r.err.trim().split("\n").at(-1) ?? r.code}`);
  }
  try {
    const commit = commitOf(staging, git);
    copyTree(staging, dest, MAX_CLONE_BYTES);
    return commit;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ── marketplaces ────────────────────────────────────────────────────────────

export interface Added {
  name: string;
  plugins: Plugin[];
  commit?: string;
}

/** Add a marketplace (or, with `replace`, refresh it from its source). */
export function addMarketplace(home: string, source: string, o: { replace?: string; runner?: Runner } = {}): Added {
  fs.mkdirSync(clonesDir(home), { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(clonesDir(home), ".staging-"));
  try {
    const commit = fetchSource(source, path.join(staging, "m"), o.runner);
    const read = readMarketplace(path.join(staging, "m"));
    const markets = readMarkets(home);
    if (o.replace ? read.name !== o.replace : markets[read.name]) throw new Error(o.replace ? `the source now calls itself ${read.name}, not ${o.replace}: remove and add it again if that is intended` : `${read.name} is already added (mnemo skills marketplace update ${read.name}, or remove it first)`);
    const dest = clonesDir(home, read.name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(path.join(staging, "m"), dest);
    writeMarkets(home, { ...markets, [read.name]: { source: markets[read.name]?.source ?? source, commit, added: markets[read.name]?.added ?? Date.now() } });
    return { name: read.name, plugins: readMarketplace(dest).plugins, commit };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function marketplacePlugins(home: string, name: string): Plugin[] {
  if (!readMarkets(home)[name]) throw new Error(`no marketplace called ${name} (mnemo skills marketplace list)`);
  return readMarketplace(clonesDir(home, name)).plugins;
}

export function removeMarketplace(home: string, name: string): string[] {
  const markets = readMarkets(home);
  if (!markets[name]) throw new Error(`no marketplace called ${name}`);
  const gone = Object.entries(readInstalled(home)).filter(([, r]) => r.marketplace === name).map(([k]) => k);
  for (const k of gone) uninstall(home, k);
  delete markets[name];
  writeMarkets(home, markets);
  fs.rmSync(clonesDir(home, name), { recursive: true, force: true });
  fs.rmSync(skillDir(home, name, ""), { recursive: true, force: true });
  return gone;
}

// ── skills ──────────────────────────────────────────────────────────────────

export function parseKey(text: string): { plugin: string; marketplace: string } {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(text.trim());
  if (!m || !NAME.test(m[1]!) || !NAME.test(m[2]!)) throw new Error("name it plugin@marketplace, as mnemo skills browse lists it");
  return { plugin: m[1]!, marketplace: m[2]! };
}

/** Install every skill of a plugin; replaces an earlier install of it. */
export function install(home: string, key: string): InstalledRecord {
  const { plugin: pluginName, marketplace } = parseKey(key);
  const market = readMarkets(home)[marketplace];
  if (!market) throw new Error(`no marketplace called ${marketplace} (mnemo skills marketplace add <owner/repo>)`);
  const plugin = marketplacePlugins(home, marketplace).find((p) => p.name === pluginName);
  if (!plugin) throw new Error(`${marketplace} lists no ${pluginName} (mnemo skills browse ${marketplace})`);
  if (plugin.skipped) throw new Error(`${pluginName} cannot be installed: ${plugin.skipped}`);
  const final = skillDir(home, marketplace, pluginName);
  fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(path.dirname(final), ".staging-"));
  try {
    const skills: InstalledRecord["skills"] = {};
    for (const s of plugin.skills) {
      copyTree(s.dir, path.join(staging, s.name), MAX_BYTES);
      skills[s.name] = hashes(path.join(staging, s.name)).files;
    }
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(staging, final);
    const record: InstalledRecord = { marketplace, plugin: pluginName, commit: market.commit, installed: Date.now(), skills };
    writeInstalled(home, { ...readInstalled(home), [`${pluginName}@${marketplace}`]: record });
    return record;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function uninstall(home: string, key: string): void {
  const { plugin, marketplace } = parseKey(key);
  const all = readInstalled(home);
  if (!all[`${plugin}@${marketplace}`]) throw new Error(`${key} is not installed`);
  delete all[`${plugin}@${marketplace}`];
  writeInstalled(home, all);
  fs.rmSync(skillDir(home, marketplace, plugin), { recursive: true, force: true });
}

/** Every file under `dir` with its hash, or why something there is not a plain file. */
function hashes(dir: string, rel = ""): { files: Record<string, string>; bad?: string } {
  const files: Record<string, string> = {};
  for (const e of fs.readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${e}` : e;
    const st = fs.lstatSync(path.join(dir, r));
    if (st.isDirectory()) {
      const sub = hashes(dir, r);
      if (sub.bad) return sub;
      Object.assign(files, sub.files);
    } else if (st.isFile()) files[r] = sha256(fs.readFileSync(path.join(dir, r)));
    else return { files, bad: `${r} is not a plain file` };
  }
  return { files };
}

/** Why a skill may not load, or undefined when it is exactly what was installed. */
export function problem(home: string, rec: InstalledRecord, skill: string): string | undefined {
  const dir = skillDir(home, rec.marketplace, rec.plugin, skill);
  try {
    const found = hashes(dir);
    if (found.bad) return found.bad;
    const want = rec.skills[skill]!;
    for (const f of Object.keys(found.files)) if (!(f in want)) return `${f} was added after it was installed`;
    for (const f of Object.keys(want)) {
      if (!(f in found.files)) return `${f} is missing`;
      if (found.files[f] !== want[f]) return `${f} changed after it was installed`;
    }
    return undefined;
  } catch {
    return "its folder is missing";
  }
}

export function verifyAll(home: string): { ok: string[]; bad: { skill: string; reason: string }[] } {
  const ok: string[] = [];
  const bad: { skill: string; reason: string }[] = [];
  for (const rec of Object.values(readInstalled(home)))
    for (const skill of Object.keys(rec.skills)) {
      const reason = problem(home, rec, skill);
      if (reason) bad.push({ skill: `${skill} (${rec.plugin}@${rec.marketplace})`, reason });
      else ok.push(skillDir(home, rec.marketplace, rec.plugin, skill));
    }
  return { ok, bad };
}
