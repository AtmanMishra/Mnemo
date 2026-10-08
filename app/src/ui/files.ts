/**
 * The file list behind `@` mentions: git's view of the project when there is
 * one (it already knows what is ignored), otherwise a bounded directory walk.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const SKIP = new Set([".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__"]);
const LIMIT = 20_000;

export function listFiles(cwd: string): string[] {
  const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (git.status === 0 && git.stdout) return git.stdout.split("\n").filter(Boolean).slice(0, LIMIT);
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(cwd, full));
      if (out.length >= LIMIT) return;
    }
  };
  walk(cwd);
  return out;
}

/** Every character of `query` in order (`sess` finds `sessions`). */
export function subsequence(text: string, query: string): boolean {
  let i = 0;
  const t = text.toLowerCase();
  for (const ch of query.toLowerCase()) {
    i = t.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

/**
 * Rank matches: a hit in the file name beats a hit in the directory, and a
 * shorter path beats a longer one.
 */
export function matchFiles(files: readonly string[], query: string, limit = 8): string[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();
  const scored: { f: string; s: number }[] = [];
  for (const f of files) {
    if (!subsequence(f, q)) continue;
    const base = path.basename(f).toLowerCase();
    const s = (base.startsWith(q) ? 0 : base.includes(q) ? 1 : f.toLowerCase().includes(q) ? 2 : 3) * 1000 + f.length;
    scored.push({ f, s });
  }
  return scored
    .sort((a, b) => a.s - b.s)
    .slice(0, limit)
    .map((x) => x.f);
}
