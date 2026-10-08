/**
 * The input's text and cursor, as pure functions so every key is testable
 * without a terminal. The cursor is an index into `text` (UTF-16 units; the
 * grapheme edge cases are not worth a dependency for a prompt line).
 */
export interface Draft {
  text: string;
  cursor: number;
}

export const empty: Draft = { text: "", cursor: 0 };

export function insert(d: Draft, s: string): Draft {
  return { text: d.text.slice(0, d.cursor) + s + d.text.slice(d.cursor), cursor: d.cursor + s.length };
}

export function backspace(d: Draft): Draft {
  if (d.cursor === 0) return d;
  return { text: d.text.slice(0, d.cursor - 1) + d.text.slice(d.cursor), cursor: d.cursor - 1 };
}

export function del(d: Draft): Draft {
  if (d.cursor >= d.text.length) return d;
  return { text: d.text.slice(0, d.cursor) + d.text.slice(d.cursor + 1), cursor: d.cursor };
}

export const left = (d: Draft): Draft => ({ ...d, cursor: Math.max(0, d.cursor - 1) });
export const right = (d: Draft): Draft => ({ ...d, cursor: Math.min(d.text.length, d.cursor + 1) });

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

function lineEnd(text: string, at: number): number {
  const i = text.indexOf("\n", at);
  return i === -1 ? text.length : i;
}

export const home = (d: Draft): Draft => ({ ...d, cursor: lineStart(d.text, d.cursor) });
export const end = (d: Draft): Draft => ({ ...d, cursor: lineEnd(d.text, d.cursor) });

const isWord = (c: string | undefined) => c !== undefined && /\S/.test(c);

export function wordLeft(d: Draft): Draft {
  let i = d.cursor;
  while (i > 0 && !isWord(d.text[i - 1])) i--;
  while (i > 0 && isWord(d.text[i - 1])) i--;
  return { ...d, cursor: i };
}

export function wordRight(d: Draft): Draft {
  let i = d.cursor;
  while (i < d.text.length && !isWord(d.text[i])) i++;
  while (i < d.text.length && isWord(d.text[i])) i++;
  return { ...d, cursor: i };
}

export function deleteWordBack(d: Draft): Draft {
  const to = wordLeft(d).cursor;
  return { text: d.text.slice(0, to) + d.text.slice(d.cursor), cursor: to };
}

/** ctrl+u: delete from the start of the current line to the cursor. */
export function killToStart(d: Draft): Draft {
  const from = lineStart(d.text, d.cursor);
  return { text: d.text.slice(0, from) + d.text.slice(d.cursor), cursor: from };
}

/** ctrl+k: delete from the cursor to the end of the current line. */
export function killToEnd(d: Draft): Draft {
  return { text: d.text.slice(0, d.cursor) + d.text.slice(lineEnd(d.text, d.cursor)), cursor: d.cursor };
}

/**
 * Move between lines of a multi-line draft, keeping the column. Returns null
 * when there is no line in that direction, so the caller can use ↑/↓ for
 * history instead.
 */
export function vertical(d: Draft, dir: -1 | 1): Draft | null {
  const start = lineStart(d.text, d.cursor);
  const col = d.cursor - start;
  if (dir === -1) {
    if (start === 0) return null;
    const prevStart = lineStart(d.text, start - 1);
    return { ...d, cursor: Math.min(prevStart + col, start - 1) };
  }
  const endAt = lineEnd(d.text, d.cursor);
  if (endAt === d.text.length) return null;
  const nextStart = endAt + 1;
  return { ...d, cursor: Math.min(nextStart + col, lineEnd(d.text, nextStart)) };
}

/** The token under the cursor when it starts with `/` (whole draft) or `@`. */
export function activeToken(d: Draft): { kind: "slash" | "file"; query: string; from: number } | null {
  if (d.text.startsWith("/") && !d.text.includes(" ") && !d.text.includes("\n")) {
    return { kind: "slash", query: d.text.slice(1), from: 0 };
  }
  let i = d.cursor;
  while (i > 0 && isWord(d.text[i - 1])) i--;
  const token = d.text.slice(i, d.cursor);
  if (token.startsWith("@")) return { kind: "file", query: token.slice(1), from: i };
  return null;
}

/** Replace the active token (from `from` to the cursor) with `value`. */
export function replaceToken(d: Draft, from: number, value: string): Draft {
  return { text: d.text.slice(0, from) + value + d.text.slice(d.cursor), cursor: from + value.length };
}
