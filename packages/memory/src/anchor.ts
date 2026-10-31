/**
 * Facts pinned to code. A fact about a function ("Cache.get must stay O(1): the hot path calls
 * it per request") is true of that function as it was. Pinned, its value ends with a tag naming
 * the definition and a hash of its text when the fact was written:
 *
 *   must stay O(1) [code: src/cache.ts#Cache.get@3k9xq]
 *
 * The tag lives in the value, so the journal, history and every agent that reads memory carry
 * it without a schema change. An agent that has a code index says whether each pinned
 * definition is as it was (`AnchorCheck`); the fact then reads as possibly stale, or about code
 * that is gone, instead of as true. An agent without one shows only what the fact is about.
 */

export interface Anchor {
  /** Project-relative, with `/`. */
  path: string;
  /** `Cache.get`, `parseConfig`. */
  qname: string;
  /** Of the definition's text when the fact was written. */
  hash: string;
}

/** fresh: the definition is as it was; changed: its text moved; gone: no such definition there. */
export type AnchorState = "fresh" | "changed" | "gone";

/** Says, for each anchor (by `anchorKey`), whether its definition is as it was. */
export type AnchorCheck = (anchors: Anchor[]) => Promise<Map<string, AnchorState>>;

const TAG = /\s*\[code: ([^\s#\]]+)#([^\s@\]]+)@([a-z0-9]+)\]$/;

export function anchorTag(a: Anchor): string {
  return `[code: ${a.path}#${a.qname}@${a.hash}]`;
}

export const anchorKey = (a: Anchor) => `${a.path}#${a.qname}@${a.hash}`;

/** A value's text and, when it is pinned, its anchor. */
export function splitAnchor(value: string): { text: string; anchor?: Anchor } {
  const m = TAG.exec(value);
  return m ? { text: value.slice(0, m.index), anchor: { path: m[1]!, qname: m[2]!, hash: m[3]! } } : { text: value };
}

/** A value as a model or a person reads it: the tag in words, and what has happened since. */
export function showValue(value: string, state?: AnchorState): string {
  const { text, anchor } = splitAnchor(value);
  if (!anchor) return value;
  const about = `${anchor.qname} in ${anchor.path}`;
  if (state === "changed") return `${text} (about ${about}, which has changed since this was written: check it still holds)`;
  if (state === "gone") return `${text} (about ${about}, which no longer exists there)`;
  return `${text} (about ${about})`;
}

/** The anchors among some values, once each. */
export function anchorsIn(values: Iterable<string>): Anchor[] {
  const out = new Map<string, Anchor>();
  for (const v of values) {
    const a = splitAnchor(v).anchor;
    if (a) out.set(anchorKey(a), a);
  }
  return [...out.values()];
}
