/**
 * `mnemo -p` asks nothing and may write anywhere in its folder. Started in the wrong
 * folder (a failed `cd` in a script, a repository with unfinished work) it changes files
 * nobody meant it to, so the one line on stderr says where it is working and why that
 * matters. A clean repository, where `git diff` shows exactly what the run did, needs none.
 */
import { spawnSync } from "node:child_process";

export function printNotice(cwd: string, mode: string): string | undefined {
  if (mode === "plan") return undefined;
  const git = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (git.error || git.status !== 0) return `mnemo: working in ${cwd}, which is not a git repository: changes cannot be undone with git (--cwd picks another folder)`;
  if (git.stdout.trim()) return `mnemo: working in ${cwd}, which has uncommitted changes: the run's edits will mix with them (--cwd picks another folder)`;
  return undefined;
}
