/**
 * Installed skill bundles: `$MNEMO_HOME/market/<name>/`, pinned in `$MNEMO_HOME/market.lock.json`.
 *
 * Installing only writes text files; nothing runs. A skill loads only if every file on disk is
 * exactly the file that was pinned (same bytes, nothing added), checked each time a session
 * starts. Folders are private (0700) and are built beside their final place under an
 * unpredictable name, then renamed into it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseBundle, sha256, type Bundle } from "./bundle.ts";

export interface Locked {
  version: string;
  /** SHA-256 of the bundle file as fetched. */
  sha256: string;
  source: string;
  files: Record<string, string>;
  installed: number;
}

export const marketDir = (home: string): string => path.join(home, "market");
const lockPath = (home: string): string => path.join(home, "market.lock.json");

export function readLock(home: string): Record<string, Locked> {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(home), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeLock(home: string, lock: Record<string, Locked>): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${lockPath(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, lockPath(home));
}

/** Install `bytes` as `pin` says; a different hash installs nothing. */
export function install(home: string, bytes: Uint8Array, source: string, pin: string): { bundle: Bundle; locked: Locked } {
  const actual = sha256(bytes);
  if (actual !== pin.toLowerCase()) throw new Error(`the bundle's SHA-256 is ${actual}, not the ${pin} you pinned: nothing was installed`);
  const bundle = parseBundle(bytes);
  const lock = readLock(home);
  if (lock[bundle.name] || fs.existsSync(path.join(marketDir(home), bundle.name))) throw new Error(`${bundle.name} is installed: remove it first (there is no silent update)`);

  fs.mkdirSync(marketDir(home), { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(marketDir(home), ".staging-"));
  try {
    fs.chmodSync(staging, 0o700);
    const files: Record<string, string> = {};
    for (const [p, text] of Object.entries(bundle.files)) {
      const file = path.join(staging, ...p.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
      files[p] = sha256(text);
    }
    fs.renameSync(staging, path.join(marketDir(home), bundle.name));
    const locked: Locked = { version: bundle.version, sha256: actual, source, files, installed: Date.now() };
    writeLock(home, { ...lock, [bundle.name]: locked });
    return { bundle, locked };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** Every file under `dir` as relative path, or a reason when something is not a plain file or folder. */
function walk(dir: string, rel = ""): { files: string[]; bad?: string } {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${entry}` : entry;
    const st = fs.lstatSync(path.join(dir, r));
    if (st.isDirectory()) {
      const sub = walk(dir, r);
      if (sub.bad) return sub;
      files.push(...sub.files);
    } else if (st.isFile()) files.push(r);
    else return { files, bad: `${r} is not a plain file` };
  }
  return { files };
}

/** Why `name` may not load, or undefined when it is exactly what was pinned. */
export function problem(home: string, name: string, locked: Locked): string | undefined {
  const dir = path.join(marketDir(home), name);
  if (!fs.existsSync(dir)) return "its folder is missing";
  const found = walk(dir);
  if (found.bad) return found.bad;
  const want = Object.keys(locked.files);
  const extra = found.files.find((f) => !(f in locked.files));
  if (extra) return `${extra} was added after it was pinned`;
  for (const p of want) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, ...p.split("/")), "utf8");
    } catch {
      return `${p} is missing`;
    }
    if (sha256(text) !== locked.files[p]) return `${p} changed after it was pinned`;
  }
  return undefined;
}

export function verifyAll(home: string): { ok: string[]; bad: { name: string; reason: string }[] } {
  const ok: string[] = [];
  const bad: { name: string; reason: string }[] = [];
  for (const [name, locked] of Object.entries(readLock(home))) {
    const reason = problem(home, name, locked);
    if (reason) bad.push({ name, reason });
    else ok.push(name);
  }
  return { ok, bad };
}

export function remove(home: string, name: string): boolean {
  const lock = readLock(home);
  if (!lock[name]) return false;
  delete lock[name];
  writeLock(home, lock);
  fs.rmSync(path.join(marketDir(home), name), { recursive: true, force: true });
  return true;
}
