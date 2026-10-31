/**
 * The surface: the files of yours that shape how an agent works and that the
 * evolve loop may later propose changes to. Today that is your agent profiles
 * (`agent/agents/*.md`), your own skills (`agent/skills/<name>/…`) and notes
 * for one model (`agent/models/*.md`). Policy, permissions, settings and the
 * memory journal are not on it (the journal keeps its own history).
 *
 * Every distinct state of the surface is kept as a version under
 * `evolve/surface/<version>/`, so any change, yours or a later accepted
 * proposal, can be listed, compared and reverted. Each outcome record names
 * the version that was in force, so the scorecard can be read per version.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentDir } from "../runtime/paths.ts";
import { evolveDir } from "./outcome.ts";

/** Folders under the agent directory that make up the surface. */
export const SURFACE_DIRS = ["agents", "skills", "models"] as const;
const MAX_FILE = 256 * 1024;

export interface SurfaceVersion {
  /** The content hash's first 12 characters: the same files are the same version. */
  id: string;
  at: string;
  /** Why it was kept: "seen at session start", "before revert to …", … */
  reason: string;
  files: string[];
}

function walk(dir: string, rel: string, out: Map<string, Buffer>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, r, out);
    else if (e.isFile()) {
      try {
        if (fs.statSync(full).size <= MAX_FILE) out.set(r, fs.readFileSync(full));
      } catch {
        /* gone while reading */
      }
    }
  }
}

/** The surface's files now, by path relative to the agent directory. */
export function readSurface(home: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const d of SURFACE_DIRS) walk(path.join(agentDir(home), d), d, out);
  return out;
}

export function surfaceHash(files: Map<string, Buffer>): string {
  const h = crypto.createHash("sha256");
  for (const [p, b] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    h.update(p).update("\0").update(crypto.createHash("sha256").update(b).digest()).update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

const versionsDir = (home: string) => path.join(evolveDir(home), "surface");

/** Keep the surface as it is now, unless that version is already kept; returns its id. */
export function snapshot(home: string, reason: string): string {
  const files = readSurface(home);
  const id = surfaceHash(files);
  const dir = path.join(versionsDir(home), id);
  if (fs.existsSync(path.join(dir, "version.json"))) return id;
  const tmp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  for (const [rel, body] of files) {
    const file = path.join(tmp, "files", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, body, { mode: 0o600 });
  }
  const v: SurfaceVersion = { id, at: new Date().toISOString(), reason, files: [...files.keys()].sort() };
  fs.writeFileSync(path.join(tmp, "version.json"), `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(tmp, dir);
  } catch {
    // Another process kept the same version first.
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return id;
}

/** Kept versions, oldest first. */
export function versions(home: string): SurfaceVersion[] {
  let names: string[];
  try {
    names = fs.readdirSync(versionsDir(home));
  } catch {
    return [];
  }
  const out: SurfaceVersion[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(versionsDir(home), n, "version.json"), "utf8")) as SurfaceVersion);
    } catch {
      /* a half-written version: skipped */
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** A version's id from a prefix; undefined when none or several match. */
export function findVersion(home: string, prefix: string): SurfaceVersion | undefined {
  const hits = versions(home).filter((v) => v.id.startsWith(prefix));
  return hits.length === 1 ? hits[0] : undefined;
}

function filesOf(home: string, id: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  walk(path.join(versionsDir(home), id, "files"), "", out);
  return out;
}

export interface SurfaceDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** What changes from version `a` to version `b` (or to the files as they are now). */
export function diffSurface(home: string, a: string, b?: string): SurfaceDiff {
  const from = filesOf(home, a);
  const to = b ? filesOf(home, b) : readSurface(home);
  return {
    added: [...to.keys()].filter((p) => !from.has(p)).sort(),
    removed: [...from.keys()].filter((p) => !to.has(p)).sort(),
    changed: [...to.keys()].filter((p) => from.has(p) && !from.get(p)!.equals(to.get(p)!)).sort(),
  };
}

/**
 * Put the surface back to a kept version. The current state is kept first, so
 * a revert can itself be reverted. Files the version did not have are removed;
 * a file too large to be kept is left alone.
 */
export function revertTo(home: string, id: string): { kept: string; diff: SurfaceDiff } {
  const kept = snapshot(home, `before revert to ${id}`);
  const target = filesOf(home, id);
  const diff = diffSurface(home, kept, id);
  const base = agentDir(home);
  for (const rel of diff.removed) {
    // Only what the snapshot itself holds is removed: an oversized file was never in it.
    fs.rmSync(path.join(base, rel), { force: true });
  }
  for (const rel of [...diff.added, ...diff.changed]) {
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, target.get(rel)!);
  }
  return { kept, diff };
}
