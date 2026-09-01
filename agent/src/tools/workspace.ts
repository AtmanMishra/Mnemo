/**
 * Workspace root used to resolve relative paths for file tools — a real jail
 * (12.6, audit e00cd116), not just a default directory.
 *
 * resolveInWorkspace() canonicalizes BOTH the root and the target through
 * realpath (resolving symlinks on every existing ancestor, so a not-yet-
 * existing file under a symlinked directory is checked correctly too) and
 * rejects anything that lands outside the root. Absolute paths and `../`
 * walks that stay inside are fine; absolute paths outside the root and
 * symlinks that escape it throw.
 *
 * Defaults to the process working directory; tests can point it at a temp dir.
 */
import * as fs from "node:fs";
import * as path from "node:path";

let workspaceRoot = process.cwd();

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

export function setWorkspaceRoot(root: string): void {
  workspaceRoot = path.resolve(root);
}

/**
 * realpath of `p`, tolerating a not-yet-existing tail: the deepest EXISTING
 * ancestor is canonicalized and the missing tail is appended verbatim. This
 * is what makes the jail hold for writes to new files under a symlinked
 * directory — canonicalizing only the final path would miss the escape.
 */
function realpathDeep(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) {
        // reached the filesystem root without finding anything that exists
        throw new Error(`workspace: cannot resolve "${p}"`);
      }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `real` is the root itself or somewhere underneath it. */
function isInside(root: string, real: string): boolean {
  return real === root || real.startsWith(root + path.sep);
}

/**
 * Resolve `p` against the workspace root and enforce containment. Returns the
 * CANONICAL path. Throws when the target is outside the root — including via
 * a symlink — so file tools cannot read or write beyond the workspace.
 */
export function resolveInWorkspace(p: string): string {
  const root = realpathDeep(workspaceRoot);
  const candidate = path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p);
  const real = realpathDeep(candidate);
  if (!isInside(root, real)) {
    throw new Error(
      `workspace: "${p}" resolves to ${real}, outside the workspace root ${root}. ` +
        `Paths must stay inside the workspace; symlinks that escape it are not followed.`,
    );
  }
  return real;
}
