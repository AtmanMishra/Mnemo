/**
 * grep over the code index's text index. The index knows, for every text file of the project,
 * which three-character sequences it holds; a pattern names some sequences every match must
 * contain, so only the files holding all of them are read. The match itself is done here, line
 * by line, so grep works the same with ripgrep installed or not.
 *
 * Narrowing never loses a match: a pattern the planner cannot read for certain (a group, a
 * class, an optional character) gives up that part, not the files. A pattern JavaScript would
 * read differently from ripgrep is not matched here at all (`compile` says undefined).
 */
import { truncateLine } from "@earendil-works/pi-coding-agent";

/**
 * The trigrams any match must contain, as alternatives: [[a, b], [c]] is (a and b) or c, from
 * a pattern's top-level `|`. Undefined when some alternative names none, so nothing narrows.
 * Only ASCII is used: the index folds case, and ASCII is where its folding and ours agree.
 */
export function requiredGrams(pattern: string, literal = false): string[][] | undefined {
  const branches = literal ? [[...pattern.split(/[^\x20-\x7e\t]+/)]] : topLevel(pattern).map(runs);
  const out: string[][] = [];
  for (const b of branches) {
    const grams = new Set<string>();
    for (const r of b) for (let i = 0; i + 3 <= r.length; i++) grams.add(r.slice(i, i + 3).toLowerCase());
    if (!grams.size) return undefined;
    out.push([...grams].slice(0, 32));
  }
  return out;
}

/** A pattern's top-level alternatives. */
function topLevel(p: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") i++;
    else if (c === "[") i = classEnd(p, i);
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) {
      out.push(p.slice(start, i));
      start = i + 1;
    }
  }
  out.push(p.slice(start));
  return out;
}

/** Where a `[...]` class that opens at `i` closes. */
function classEnd(p: string, i: number): number {
  let j = i + 1;
  if (p[j] === "^") j++;
  if (p[j] === "]") j++;
  for (; j < p.length; j++) {
    if (p[j] === "\\") j++;
    else if (p[j] === "]") return j;
  }
  return p.length;
}

/** Where a group that opens at `i` closes. */
function groupEnd(p: string, i: number): number {
  let depth = 0;
  for (let j = i; j < p.length; j++) {
    if (p[j] === "\\") j++;
    else if (p[j] === "[") j = classEnd(p, j);
    else if (p[j] === "(") depth++;
    else if (p[j] === ")" && --depth === 0) return j;
  }
  return p.length;
}

/** The literal runs of one alternative that every match contains. */
function runs(b: string): string[] {
  const out: string[] = [];
  let cur = "";
  const end = () => {
    if (cur.length >= 3) out.push(cur);
    cur = "";
  };
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (c === "\\") {
      const n = b[++i];
      // An escaped punctuation mark is itself; a letter or digit is a class or an anchor.
      if (n !== undefined && /[^A-Za-z0-9]/.test(n) && n.charCodeAt(0) < 0x7f) cur += n;
      else end();
    } else if (c === "[") {
      i = classEnd(b, i);
      end();
    } else if (c === "(") {
      i = groupEnd(b, i);
      end();
    } else if (c === "*" || c === "?") {
      cur = cur.slice(0, -1); // the character before is optional
      end();
    } else if (c === "{") {
      const q = /^\{(\d*)(,\d*)?\}/.exec(b.slice(i));
      if (q && !Number(q[1] || "0")) cur = cur.slice(0, -1);
      end();
      if (q) i += q[0].length - 1;
    } else if (c === "+" || c === "." || c === "^" || c === "$" || c.charCodeAt(0) > 0x7e || c.charCodeAt(0) < 0x20) end();
    else cur += c;
  }
  end();
  return out;
}

/**
 * The pattern as a RegExp that matches what ripgrep would match on one line, or undefined when
 * JavaScript would read it differently: POSIX classes, inline flags other than a leading
 * `(?i)`, `\p{…}`, `\A`, `\z` and the like. Those go to ripgrep.
 */
export function compile(pattern: string, o: { literal?: boolean; ignoreCase?: boolean } = {}): RegExp | undefined {
  if (o.literal) return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), o.ignoreCase ? "i" : "");
  let p = pattern;
  let flags = o.ignoreCase ? "i" : "";
  if (p.startsWith("(?i)")) {
    p = p.slice(4);
    flags = "i";
  }
  if (/\[\[:|\(\?[A-Za-z-]|\\[AzQEpPCKGXR]/.test(p)) return undefined;
  try {
    return new RegExp(p, flags);
  } catch {
    return undefined;
  }
}

/** rg's `--glob`: without a `/` it matches a file's name at any depth; `!` excludes. */
export function globMatch(glob: string, rel: string): boolean {
  const neg = glob.startsWith("!");
  const g = neg ? glob.slice(1) : glob;
  const hit = new Bun.Glob(g).match(g.includes("/") ? rel : (rel.split("/").pop() ?? rel));
  return neg ? !hit : hit;
}

export interface GrepFile {
  /** As the output names it: relative to the searched folder, or the file's name. */
  shown: string;
  text: string;
}

/** Matching lines in pi's grep format (`path:line: text`, context as `path-line- text`). */
export function grepLines(files: Iterable<GrepFile>, re: RegExp, o: { context?: number; limit: number; signal?: AbortSignal }) {
  const lines: string[] = [];
  let matches = 0;
  let truncated = false;
  const ctx = o.context && o.context > 0 ? o.context : 0;
  const line = (s: string) => {
    const t = truncateLine(s);
    if (t.wasTruncated) truncated = true;
    return t.text;
  };
  outer: for (const f of files) {
    if (o.signal?.aborted) throw new Error("Operation aborted");
    const all = f.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (all.at(-1) === "") all.pop();
    for (let i = 0; i < all.length; i++) {
      if (!re.test(all[i]!)) continue;
      for (let j = Math.max(0, i - ctx); j <= Math.min(all.length - 1, i + ctx); j++)
        lines.push(j === i ? `${f.shown}:${j + 1}: ${line(all[j]!)}` : `${f.shown}-${j + 1}- ${line(all[j]!)}`);
      if (++matches >= o.limit) break outer;
    }
  }
  return { lines, matches, limitReached: matches >= o.limit, linesTruncated: truncated };
}
