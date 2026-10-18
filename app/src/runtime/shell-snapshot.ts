/**
 * What a shell command changed, so a rewind can put it back too.
 *
 * Before and after a command, the project's files (the ones git does not ignore) are
 * hashed into a tree with a private index, so neither the user's index nor their
 * branches change. The two trees' difference is the command's: each file it added,
 * changed or deleted, with its bytes from before. Outside a git repository nothing is
 * kept, and a command that changes files after it returns (a server it started) is
 * not seen.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SAFE_GIT, trustedBin } from "./bin.ts";

export interface Snapshot {
  root: string;
  tree: string;
}

/** null: the file did not exist before. */
export type Change = { file: string; before: Buffer | null };

const TIMEOUT = 15_000;

function git(bin: string, cwd: string, args: string[], env?: Record<string, string>): Buffer | undefined {
  const r = Bun.spawnSync([bin, ...SAFE_GIT, ...args], { cwd, env: env ? { ...process.env, ...env } : undefined, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TIMEOUT });
  return r.exitCode === 0 ? r.stdout : undefined;
}

/** The project's files as a git tree, or undefined outside a repository (or when git fails). */
export function snapshot(cwd: string): Snapshot | undefined {
  const bin = trustedBin("git");
  if (!bin) return undefined;
  const top = git(bin, cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"])?.toString().trim().split("\n");
  if (!top || top.length < 2) return undefined;
  const [root, gitDir] = top as [string, string];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-snap-"));
  try {
    const index = path.join(dir, "index");
    // From the real index, so only files whose stat changed are read again.
    try {
      fs.copyFileSync(path.join(gitDir, "index"), index);
    } catch {
      /* a repository with no commits yet */
    }
    const env = { GIT_INDEX_FILE: index };
    if (!git(bin, root, ["add", "-A", "--", "."], env)) return undefined;
    const tree = git(bin, root, ["write-tree"], env)?.toString().trim();
    return tree ? { root, tree } : undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What changed between a snapshot and the files now, each with its bytes from before. */
export function changedSince(before: Snapshot): Change[] {
  const bin = trustedBin("git");
  const after = snapshot(before.root);
  if (!bin || !after || after.tree === before.tree) return [];
  const out = git(bin, before.root, ["diff-tree", "-r", "--no-renames", "-z", before.tree, after.tree]);
  if (!out) return [];
  // `:<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0`, repeated.
  const parts = out.toString("utf8").split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [, , oldSha, , status] = parts[i]!.slice(1).split(" ");
    const file = path.join(before.root, parts[i + 1]!);
    if (status === "A") changes.push({ file, before: null });
    else {
      const blob = git(bin, before.root, ["cat-file", "blob", oldSha!]);
      if (blob) changes.push({ file, before: blob });
    }
  }
  return changes;
}
