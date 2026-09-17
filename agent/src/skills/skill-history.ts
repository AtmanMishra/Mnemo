/**
 * Reversible skill edits: a timestamped copy of a SKILL.md is taken BEFORE
 * patch_skill / retire_skill rewrite it, so any edit can be undone without
 * git, and a stale expectedHash can be told apart from a lost edit.
 *
 * Backups live under the Mnemo home: ~/.mnemo/skill-history/<name>/<stamp>.md
 * with the file-safe ISO stamp of the edit. setMnemoHome() lets tests point
 * the home at a temp dir — a test must never touch the real ~/.mnemo.
 */
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { mnemoHome as envMnemoHome } from "../home.ts";

let mnemoHomeOverride: string | null = null;

/** Tests: redirect the Mnemo home (~/.mnemo) to a temp dir. */
export function setMnemoHome(home: string | null): void {
  mnemoHomeOverride = home;
}

/**
 * The Mnemo home: history + retired trees live here.
 *
 * The default is `src/home.ts`'s — `$MNEMO_HOME`, then `~/.mnemo` — so a
 * relocated home moves the skill history with the journal instead of leaving
 * backups behind in a directory the user no longer uses. The explicit override
 * above wins over both, because a test must never touch the real home.
 */
export function mnemoHome(): string {
  return mnemoHomeOverride ?? envMnemoHome();
}

/** History directory for one skill: ~/.mnemo/skill-history/<name>. */
export function skillHistoryDir(name: string): string {
  return path.join(mnemoHome(), "skill-history", safeSegment(name));
}

/** One path segment from arbitrary (frontmatter-supplied) text. */
export function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-{2,}/g, "-");
  return cleaned || "unnamed";
}

/** sha256 of a file body, hex. The value patch_skill's expectedHash compares against. */
export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The timestamp of an edit, in two shapes: `iso` for memory values, `file`
 * for the history file name. Both keep the ISO-8601 shape; the file one
 * drops the characters Windows forbids in names (`:`, `.`).
 */
export function fileStamp(now: Date = new Date()): { iso: string; file: string } {
  const iso = now.toISOString();
  return { iso, file: iso.replace(/[:.]/g, "-") };
}

/**
 * Write the pre-edit body to the history dir and return the file written.
 * Collision-safe: two patches inside the same millisecond never overwrite
 * one another's undo copy.
 */
export async function backupSkillBody(opts: { name: string; body: string; now?: Date }): Promise<string> {
  const dir = skillHistoryDir(opts.name);
  await fsp.mkdir(dir, { recursive: true });
  const base = fileStamp(opts.now).file;
  let file = path.join(dir, `${base}.md`);
  for (let n = 2; ; n++) {
    try {
      await fsp.access(file);
      file = path.join(dir, `${base}-${n}.md`); // same stamp: keep both copies
    } catch {
      break;
    }
  }
  await fsp.writeFile(file, opts.body, "utf8");
  return file;
}

/** Undo files for one skill, oldest first (what `undo` would offer next). */
export async function listHistory(name: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(skillHistoryDir(name));
    return entries.filter((e) => e.endsWith(".md")).sort().map((e) => path.join(skillHistoryDir(name), e));
  } catch {
    return []; // no history yet is not an error
  }
}
