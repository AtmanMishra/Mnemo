/**
 * A skill bundle is one JSON file: a name, a version and the text files of the skill. It has
 * no archive to unpack, so there is no path to escape from, and it is pinned by the SHA-256 of
 * its bytes, so what is installed is exactly what was read.
 */
import { createHash } from "node:crypto";

export interface Bundle {
  name: string;
  version: string;
  description: string;
  files: Record<string, string>;
}

export const MAX_BUNDLE = 1024 * 1024;
const MAX_FILES = 50;
const MAX_FILE = 256 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Segments of letters, digits, dot, dash and underscore; none starts with a dot (no `.git`, no `..`).
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function validPath(p: string): boolean {
  return p.length <= 200 && p.split("/").every((s) => SEGMENT.test(s));
}

export function parseBundle(bytes: Uint8Array): Bundle {
  if (bytes.length > MAX_BUNDLE) throw new Error(`a bundle is at most ${MAX_BUNDLE / 1024} KB`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("not a skill bundle: not UTF-8 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a skill bundle");
  const { name, version, description, files } = raw as Record<string, unknown>;
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("name must be lowercase letters, digits and dashes");
  if (typeof version !== "string" || version.length === 0 || version.length > 32) throw new Error("version must be a short string");
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) throw new Error("description must be a string of at most 500 characters");
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("files must be an object of path to text");
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FILES) throw new Error(`a bundle has 1 to ${MAX_FILES} files`);
  const out: Record<string, string> = {};
  for (const [p, text] of entries) {
    if (!validPath(p)) throw new Error(`file name "${p}" is not allowed`);
    if (typeof text !== "string" || text.length > MAX_FILE || text.includes("\0")) throw new Error(`${p} must be text of at most ${MAX_FILE / 1024} KB`);
    out[p] = text;
  }
  if (!("SKILL.md" in out)) throw new Error("a bundle needs a SKILL.md");
  return { name, version, description: (description as string | undefined) ?? "", files: out };
}
