/**
 * The agent tree as lines of text: pure, so the agents page, the split's
 * sub-agent panes and the playground draw one shape and a test can read it.
 *
 *   ● alpha
 *   ├─ ✓ mapper      map the modules
 *   │  └─ ✓ reader   read src/fetch.ts
 *   └─ ● checker     check the API
 */
import type { NodeStatus, RosterNode, RosterSnapshot } from "../runtime/roster.ts";
import { palette } from "./theme.ts";

export interface TreeLine {
  node: RosterNode;
  /** The branch drawing before the glyph. */
  prefix: string;
}

/** One root's tree, depth first. */
export function treeOf(nodes: readonly RosterNode[], rootId: number): TreeLine[] {
  const out: TreeLine[] = [];
  const walk = (n: RosterNode, ancestors: string, branch: string) => {
    out.push({ node: n, prefix: ancestors + branch });
    const kids = nodes.filter((c) => c.parent === n.id);
    const next = ancestors + (branch === "" ? "" : branch === "└─ " ? "   " : "│  ");
    kids.forEach((c, i) => walk(c, next, i === kids.length - 1 ? "└─ " : "├─ "));
  };
  const root = nodes.find((n) => n.id === rootId);
  if (root) walk(root, "", "");
  return out;
}

export function statusStyle(s: NodeStatus): { glyph: string; tone: string } {
  switch (s) {
    case "running":
      return { glyph: "●", tone: palette.magenta };
    case "done":
      return { glyph: "✓", tone: palette.green };
    case "failed":
      return { glyph: "✗", tone: palette.red };
    case "stopped":
      return { glyph: "■", tone: palette.amber };
    default:
      return { glyph: "·", tone: palette.faint };
  }
}

export const live = (n: RosterNode): boolean => n.status === "running";

/** Sub-agents under `rootId`, at any depth. */
export function subsOf(snap: Pick<RosterSnapshot, "nodes">, rootId: number): RosterNode[] {
  const out: RosterNode[] = [];
  const walk = (id: number) => {
    for (const c of snap.nodes.filter((n) => n.parent === id)) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(rootId);
  return out;
}

/** Roots linked to `rootId`, itself not included. */
export function linkedRoots(snap: Pick<RosterSnapshot, "nodes" | "groups">, rootId: number): RosterNode[] {
  const g = snap.groups.get(rootId);
  return g === undefined ? [] : snap.nodes.filter((n) => n.kind === "root" && n.id !== rootId && snap.groups.get(n.id) === g);
}

/** The summary the agents page puts on a card: "⇄ beta · ⑂ 3 sub-agents (1 running)". */
export function relation(snap: Pick<RosterSnapshot, "nodes" | "groups">, rootId: number): string {
  const linked = linkedRoots(snap, rootId);
  const subs = subsOf(snap, rootId);
  const running = subs.filter(live).length;
  const parts = [
    linked.length ? `⇄ ${linked.map((n) => n.label).join(", ")}` : "",
    subs.length ? `⑂ ${subs.length} sub-agent${subs.length === 1 ? "" : "s"}${running ? ` (${running} running)` : ""}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Which panes a "split with family" should show, at most `max`: the agent, then
 * the roots linked to it, then its sub-agents, each group ranked by what needs
 * you most (running first, then the newest). `hidden` is how many related nodes
 * did not fit.
 */
export function familyPanes(snap: Pick<RosterSnapshot, "nodes" | "groups">, rootId: number, max = 4): { keys: string[]; hidden: number } {
  const rank = (a: RosterNode, b: RosterNode) => Number(live(b)) - Number(live(a)) || b.startedAt - a.startedAt;
  const linked = linkedRoots(snap, rootId).sort(rank);
  const subs = subsOf(snap, rootId).sort(rank);
  const agentKey = (n: RosterNode) => `a${n.agentId ?? n.id}`;
  const self = snap.nodes.find((n) => n.id === rootId);
  const all = [...(self ? [agentKey(self)] : []), ...linked.map(agentKey), ...subs.map((n) => `n${n.id}`)];
  return { keys: all.slice(0, max), hidden: Math.max(0, all.length - max) };
}
