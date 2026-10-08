/**
 * Did a recalled memory get used? (audit F14)
 *
 * Retrieval cannot reward itself: a memory earns a "useful" vote only when the
 * answer or a later tool call reuses words that are *distinctive* to it — not
 * in the user's message (that would be an echo) and not shared with the other
 * recalled items (that would not say which one helped). Conservative on
 * purpose: missing a vote costs little, a false vote teaches the ranking a lie.
 * Ignoring a memory is not evidence against it, so this never votes down.
 */
const COMMON = new Set([
  "this", "that", "with", "from", "have", "will", "then", "when", "only", "always", "never", "should",
  "into", "your", "their", "they", "them", "what", "which", "there", "these", "those", "were", "been",
  "also", "project", "user", "facts", "fact", "memory", "would", "could", "about", "after", "before",
]);

export function tokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) ?? []).filter((t) => t.length >= 4 && !COMMON.has(t) && !/^\d+$/.test(t)),
  );
}

export class Credit {
  private pending = new Map<number, Set<string>>();

  /** Register what was recalled for a message. */
  recalled(items: { node: number; text: string }[], prompt: string): void {
    this.pending.clear();
    const asked = tokens(prompt);
    const sets = items.map((i) => ({ node: i.node, t: tokens(i.text) }));
    for (const s of sets) {
      const distinct = [...s.t].filter((t) => !asked.has(t) && !sets.some((o) => o.node !== s.node && o.t.has(t)));
      if (distinct.length) this.pending.set(s.node, new Set(distinct));
    }
  }

  /** Text the agent produced (an answer, a tool's arguments). Returns nodes newly credited. */
  observe(text: string): number[] {
    const used = tokens(text);
    const credited: number[] = [];
    for (const [node, distinct] of this.pending) {
      const hits = [...distinct].filter((t) => used.has(t)).length;
      if (hits >= Math.min(2, distinct.size)) {
        credited.push(node);
        this.pending.delete(node);
      }
    }
    return credited;
  }
}
