/**
 * Where a file tool's path really lands, for the gate.
 *
 * The gate must read a path the way the tool will open it, or a check on one
 * spelling is bypassed by another. pi's tools (utils/paths.js `resolveToCwd`)
 * turn unicode spaces into spaces, drop a leading `@`, read Git Bash / WSL
 * drive paths (`/c/x`, `/mnt/c/x`) on Windows, expand `~` (and `~\` on
 * Windows) and `file://`; the operating system then follows symlinks, and on
 * Windows ignores trailing dots and spaces, reads `name:stream` as `name` and
 * compares without case. Everything here takes the platform as an argument so
 * the Windows rules can be tested anywhere.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface PathSystem {
  path: typeof path.posix;
  windows: boolean;
  /** Names compare without case (Windows, and macOS by default). */
  fold: boolean;
  home: string;
  /** Symlinks resolved; undefined when they cannot be. */
  real(p: string): string | undefined;
}

export function nativeSystem(): PathSystem {
  return {
    path,
    windows: process.platform === "win32",
    fold: process.platform === "win32" || process.platform === "darwin",
    home: os.homedir(),
    real: realPath,
  };
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** pi's `normalizeWindowsShellPath`: `/c/x`, `/mnt/c/x`, `/cygdrive/c/x` → `C:\x`. */
function windowsShellPath(p: string): string {
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
  const m = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(p);
  return m ? `${m[1]!.toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}` : p;
}

/** The absolute path a pi file tool opens for `p`, before symlinks; undefined when it names no path here. */
export function toolTarget(cwd: string, p: string, sys: PathSystem = nativeSystem()): string | undefined {
  let s = p.replace(UNICODE_SPACES, " ");
  if (s.startsWith("@")) s = s.slice(1);
  if (sys.windows) s = windowsShellPath(s);
  if (s === "~") s = sys.home;
  else if (s.startsWith("~/") || (sys.windows && s.startsWith("~\\"))) s = sys.path.join(sys.home, s.slice(2));
  else if (/^file:\/\//.test(s)) {
    try {
      s = fileURLToPath(s, { windows: sys.windows });
    } catch {
      // A `file:///etc/hosts` on Windows has no drive: it opens nothing.
      return undefined;
    }
  }
  const abs = sys.path.resolve(cwd, s);
  return sys.windows ? win32Canonical(abs) : abs;
}

/** What Windows opens for a path: `.git. ` is `.git`, `a.txt::$DATA` is `a.txt`. */
export function win32Canonical(p: string): string {
  const root = path.win32.parse(p).root;
  const parts = p
    .slice(root.length)
    .split(/[\\/]/)
    .map((c) => (c === "." || c === ".." ? c : c.replace(/:.*$/, "").replace(/[. ]+$/, "")))
    .filter(Boolean);
  return path.win32.join(root, ...parts);
}

/**
 * Symlinks resolved component by component, dangling ones included: a link
 * to a file that does not exist yet is where a write will create it. The part
 * past the last existing component is appended as written. Undefined for a
 * loop or a link that cannot be read, which callers treat as outside everything.
 */
export function realPath(p: string): string | undefined {
  const abs = path.resolve(p);
  let at = path.parse(abs).root;
  let todo = abs.slice(at.length).split(path.sep).filter(Boolean);
  let links = 0;
  let missing = false;
  while (todo.length) {
    const part = todo.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      at = path.dirname(at);
      continue;
    }
    const next = path.join(at, part);
    if (!missing) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(next);
      } catch {
        missing = true;
        at = next;
        continue;
      }
      if (st.isSymbolicLink()) {
        if (++links > 40) return undefined;
        let target: string;
        try {
          target = fs.readlinkSync(next);
        } catch {
          return undefined;
        }
        const troot = path.parse(target).root;
        if (troot) at = path.resolve(troot);
        todo = [...target.slice(troot.length).split(/[\\/]/).filter(Boolean), ...todo];
        continue;
      }
    }
    at = next;
  }
  return at;
}

/** `p` relative to `base` when it is inside it ("" for itself), else undefined. Both already resolved. */
export function within(base: string, p: string, sys: PathSystem = nativeSystem()): string | undefined {
  const inside = (rel: string) => !(rel === ".." || rel.startsWith(`..${sys.path.sep}`) || sys.path.isAbsolute(rel));
  const rel = sys.path.relative(base, p);
  if (inside(rel)) return rel;
  if (!sys.fold) return undefined;
  const folded = sys.path.relative(base.toLowerCase(), p.toLowerCase());
  return inside(folded) ? folded : undefined;
}

/** The real form of a tool's path: undefined when it opens nothing or cannot be resolved. */
export function realTarget(cwd: string, p: string, sys: PathSystem = nativeSystem()): string | undefined {
  const target = toolTarget(cwd, p, sys);
  return target === undefined ? undefined : sys.real(target);
}
