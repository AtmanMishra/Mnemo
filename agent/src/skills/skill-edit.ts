/**
 * Pure text surgery for patch_skill / retire_skill.
 *
 * The edits are deliberately literal: an anchor either occurs exactly once
 * or the patch is refused — a fuzzy match would silently rewrite a line the
 * model never read. Everything here is a pure function, so every refusal
 * path is unit-testable without touching a filesystem or a memory sidecar.
 */
import { parseFrontmatter } from "./discovery.ts";

/** One normalized edit: a unique-anchor replacement or a ##-section rewrite. */
export type SkillEdit =
  | { kind: "replace"; find: string; replace: string }
  | { kind: "section"; section: string; body: string };

const clip = (s: string, max = 60): string => (s.length > max ? s.slice(0, max) + "…" : s);
const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, " ").trim();
const stripEol = (line: string): string => line.replace(/\r?\n$/, "");
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const eolOf = (content: string): string => (content.includes("\r\n") ? "\r\n" : "\n");

/**
 * Validate the model's `edits` argument. Each entry is ONE of the two forms;
 * mixing them, emptying the anchor, or passing a non-string is a refusal,
 * never a guess.
 */
export function normalizeEdits(raw: unknown, tool = "patch_skill"): SkillEdit[] {
  const list: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  if (list.length === 0) {
    throw new Error(`${tool}: edits must be a non-empty array of {find, replace} or {section, body} objects`);
  }
  return list.map((entry, i) => normalizeEdit(entry, i + 1, tool));
}

function normalizeEdit(entry: unknown, n: number, tool: string): SkillEdit {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${tool}: edit ${n} must be an object`);
  }
  const e = entry as Record<string, unknown>;
  const hasAnchor = e.find !== undefined || e.replace !== undefined;
  const hasSection = e.section !== undefined || e.body !== undefined;
  if (hasAnchor && hasSection) {
    throw new Error(`${tool}: edit ${n} is ambiguous — use {find, replace} or {section, body}, never both in one edit`);
  }
  if (hasSection) {
    if (typeof e.section !== "string") throw new Error(`${tool}: edit ${n} needs "section" as a string (a '## heading' name)`);
    const section = e.section.trim().replace(/^#+[ \t]*/, "").replace(/[ \t]*#+$/, "").trim();
    if (!section) throw new Error(`${tool}: edit ${n} has an empty "section" heading name`);
    if (typeof e.body !== "string") throw new Error(`${tool}: edit ${n} needs "body" as a string (the new section text)`);
    return { kind: "section", section, body: e.body };
  }
  if (typeof e.find !== "string" || typeof e.replace !== "string") {
    throw new Error(`${tool}: edit ${n} needs string "find" and "replace" (or "section" and "body")`);
  }
  if (e.find.length === 0) {
    throw new Error(`${tool}: edit ${n} has an empty "find" — an empty anchor matches everywhere`);
  }
  return { kind: "replace", find: e.find, replace: e.replace };
}

/** Apply every edit in order, each against the result of the previous one. */
export function applyEdits(content: string, edits: SkillEdit[], file: string, tool = "patch_skill"): string {
  let out = content;
  for (const [i, edit] of edits.entries()) {
    out =
      edit.kind === "replace"
        ? applyAnchor(out, edit.find, edit.replace, i + 1, file, tool)
        : applySection(out, edit.section, edit.body, i + 1, file, tool);
  }
  return out;
}

/** Replace one unique occurrence of `find`; zero or several occurrences refuse. */
function applyAnchor(content: string, find: string, replace: string, n: number, file: string, tool: string): string {
  const first = content.indexOf(find);
  if (first < 0) {
    throw new Error(`${tool}: edit ${n}: anchor "${clip(oneLine(find))}" does not appear in ${file}`);
  }
  if (content.indexOf(find, first + find.length) >= 0) {
    throw new Error(
      `${tool}: edit ${n}: anchor "${clip(oneLine(find))}" appears more than once in ${file} — ` +
        `include more surrounding context so the anchor is unique`,
    );
  }
  return content.slice(0, first) + replace + content.slice(first + find.length);
}

/**
 * Replace the text under a `## <section>` heading, up to the next level-2
 * heading (or EOF). Nested `###` headings belong to the section and are
 * replaced with it; the heading line itself stays. When a next heading
 * follows, one blank line between the new body and it is kept.
 */
function applySection(content: string, section: string, body: string, n: number, file: string, tool: string): string {
  const lines = content.split(/(?<=\n)/); // each line keeps its own terminator
  const headingRe = new RegExp(`^##[ \\t]+${escapeRegExp(section)}[ \\t]*#*[ \\t]*$`, "i");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(stripEol(lines[i]))) hits.push(i);
  }
  if (hits.length === 0) {
    throw new Error(`${tool}: edit ${n}: no "## ${section}" section in ${file}`);
  }
  if (hits.length > 1) {
    throw new Error(`${tool}: edit ${n}: "## ${section}" appears ${hits.length} times in ${file} — the section name is ambiguous`);
  }
  const head = hits[0];
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    if (/^##(?!#)[ \t]/.test(stripEol(lines[i]))) {
      end = i;
      break;
    }
  }
  const eol = eolOf(content);
  const trimmed = body.replace(/(?:\r?\n)+$/, "");
  const bodyLines = trimmed === "" ? [] : trimmed.split(/\r?\n/);
  const out: string[] = lines.slice(0, head + 1);
  for (const [i, line] of bodyLines.entries()) {
    const last = i === bodyLines.length - 1;
    // a section running to EOF in a file with no trailing newline must not
    // gain one: everything outside the edited region stays byte-for-byte
    const terminate = !(last && end === lines.length && !/[\r\n]$/.test(content));
    out.push(line + (terminate ? eol : ""));
  }
  if (end < lines.length && (bodyLines.length === 0 || bodyLines[bodyLines.length - 1].trim() !== "")) {
    out.push(eol); // one blank line before the next heading
  }
  out.push(...lines.slice(end));
  return out.join("");
}

export interface PatchedSkillCheck {
  name: string;
  description: string;
}

/**
 * The post-edit invariant: the file must still be a discoverable skill with
 * the SAME name and a description. A patch improves a skill; it does not
 * rename, retire or de-frontmatter one — those have their own tools.
 */
export function assertPatchedSkill(content: string, name: string, file: string, tool = "patch_skill"): PatchedSkillCheck {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    throw new Error(`${tool}: the edits would leave ${file} without valid frontmatter (--- fences with flat key: value lines)`);
  }
  const nextName = (parsed.meta.name ?? "").trim();
  const description = (parsed.meta.description ?? "").trim();
  if (!nextName) {
    throw new Error(`${tool}: the edits would remove "name" from the frontmatter of ${file}`);
  }
  if (nextName !== name) {
    throw new Error(
      `${tool}: the edits would rename the skill ("${name}" -> "${nextName}") — patch_skill improves a skill, it does not rename it`,
    );
  }
  if (!description) {
    throw new Error(`${tool}: the edits would remove "description" from the frontmatter of ${file} — discovery needs it`);
  }
  if (parsed.meta.retired !== undefined) {
    throw new Error(`${tool}: the edits would set "retired" on ${name} — use retire_skill so the retirement is recorded`);
  }
  return { name: nextName, description };
}

/**
 * Mark a skill superseded: the frontmatter gains `retired: "<reason>"` and
 * discovery stops offering it. Nothing else in the file is touched, so
 * deleting the line un-retires the skill.
 */
export function markRetired(content: string, reason: string, file: string, tool = "retire_skill"): string {
  const parsed = parseFrontmatter(content);
  const name = (parsed?.meta.name ?? "").trim();
  const description = (parsed?.meta.description ?? "").trim();
  if (!parsed || !name || !description) {
    throw new Error(`${tool}: ${file} has no valid frontmatter (name + description) to retire`);
  }
  const lines = content.split(/(?<=\n)/);
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (stripEol(lines[i]).trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) throw new Error(`${tool}: ${file} has no closing frontmatter fence`);
  const meta = lines.slice(1, close).filter((line) => !/^\s*retired\s*:/i.test(stripEol(line)));
  // one line, double-quoted: a reason containing ':' or '#' must not turn
  // into YAML syntax when another tool reads the frontmatter
  const value = `"${oneLine(reason).replace(/"/g, "'")}"`;
  return [...lines.slice(0, 1), ...meta, `retired: ${value}${eolOf(content)}`, ...lines.slice(close)].join("");
}
