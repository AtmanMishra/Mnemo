/**
 * Which project a working directory belongs to (audit F12).
 *
 * A path is a poor identity: a subdirectory, a second worktree or a moved
 * clone would each get their own memory. Inside git the identity is the
 * normalized `origin` URL (so every clone of the repo shares one memory),
 * falling back to the repository root when there is no remote, and to the
 * directory itself outside git.
 *
 * A path alone is also too weak the other way: `/app` or `/workspace` in one
 * container after another are different projects at the same path (on
 * Terminal-Bench, every task's facts were recalled into the next). So an
 * identity built from a path carries the folder's creation time when the
 * filesystem reports one: the same folder keeps it, a new one at that path
 * does not.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectIdentity {
  /** Stable key: `git:github.com/owner/repo`, `repo:/abs/root@<born>` or `dir:/abs/cwd@<born>`. */
  id: string;
  /** Where the project's files are (the git root, or the directory). */
  root: string;
  /** Short human name for transcripts. */
  name: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** `git@github.com:Owner/Repo.git`, `https://user@github.com/Owner/Repo` → `github.com/owner/repo`. */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  return u.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

/** `@<ms>` when the folder's creation time is known, else nothing. */
function born(dir: string): string {
  try {
    const t = Math.floor(fs.statSync(dir).birthtimeMs);
    return t > 0 ? `@${t}` : "";
  } catch {
    return "";
  }
}

export function projectIdentity(cwd: string): ProjectIdentity {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    const dir = path.resolve(cwd);
    return { id: `dir:${dir}${born(dir)}`, root: dir, name: path.basename(cwd) };
  }
  const remote = git(root, ["config", "--get", "remote.origin.url"]);
  if (remote) {
    const id = normalizeRemote(remote);
    return { id: `git:${id}`, root, name: id.split("/").pop() ?? path.basename(root) };
  }
  return { id: `repo:${root}${born(root)}`, root, name: path.basename(root) };
}
