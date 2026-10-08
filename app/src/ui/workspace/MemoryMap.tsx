/**
 * What memory holds about this project, as a constellation: the project in
 * the middle, wired to what is known about it — the project's facts to the
 * right, yours to the left, pitfalls and their fixes below, past sessions
 * above. ←→↑↓ walk the nodes, enter opens one, esc closes the map.
 *
 *            · session: fix the login bug
 *             ·
 *   editor ◆····◉ clsx ·······◆ verify command
 *                  ·
 *                   ◆ pitfall: npm test on node 22
 */
import React from "react";
import { Box, Text } from "ink";
import { palette } from "../theme.ts";
import type { Item } from "./model.ts";

export interface MapNode {
  id: string;
  label: string;
  detail?: string;
  group: "project" | "user" | "pitfall" | "session";
  x: number;
  y: number;
}

const GROUP: Record<MapNode["group"], { from: number; to: number; color: () => string; mark: string }> = {
  project: { from: -70, to: 70, color: () => palette.cyan, mark: "◆" },
  pitfall: { from: 75, to: 135, color: () => palette.amber, mark: "▲" },
  user: { from: 110, to: 250, color: () => palette.violet, mark: "◆" },
  session: { from: 225, to: 315, color: () => palette.dim, mark: "■" },
};
const PER_GROUP = 9;

/** Which group a sidebar memory row belongs to, from its id and kind. */
function groupOf(item: Item): MapNode["group"] | undefined {
  if (item.kind === "pitfall") return "pitfall";
  if (item.kind === "session") return "session";
  if (item.id.startsWith("p:")) return "project";
  if (item.id.startsWith("u:")) return "user";
  return undefined;
}

/** Nodes placed on an ellipse around the centre, each group in its own arc. */
export function layoutMap(items: readonly Item[], width: number, height: number): { nodes: MapNode[]; cx: number; cy: number; more: number } {
  const cx = Math.floor(width / 2) - 4;
  const cy = Math.floor(height / 2);
  const rx = Math.max(10, Math.floor(width * 0.3));
  const ry = Math.max(3, Math.floor(height * 0.38));
  const groups = new Map<MapNode["group"], Item[]>();
  for (const it of items) {
    const g = groupOf(it);
    if (g) groups.set(g, [...(groups.get(g) ?? []), it]);
  }
  const nodes: MapNode[] = [];
  let more = 0;
  for (const [g, list] of groups) {
    const shown = list.slice(0, PER_GROUP);
    more += list.length - shown.length;
    const { from, to } = GROUP[g];
    shown.forEach((it, i) => {
      const t = shown.length === 1 ? 0.5 : i / (shown.length - 1);
      const a = ((from + (to - from) * t) * Math.PI) / 180;
      nodes.push({
        id: it.id,
        label: it.label,
        detail: it.detail,
        group: g,
        x: Math.round(cx + Math.cos(a) * rx),
        y: Math.max(0, Math.min(height - 1, Math.round(cy + Math.sin(a) * ry))),
      });
    });
  }
  return { nodes, cx, cy, more };
}

type Cell = { ch: string; color: string; bg?: string; bold?: boolean };

export function MemoryMap({ items, project, width, height, selected }: { items: readonly Item[]; project: string; width: number; height: number; selected: number }): React.ReactElement {
  const canvasH = Math.max(6, height - 3);
  const { nodes, cx, cy, more } = layoutMap(items, width, canvasH);
  const grid: (Cell | undefined)[][] = Array.from({ length: canvasH }, () => Array<Cell | undefined>(width).fill(undefined));
  const put = (x: number, y: number, c: Cell) => {
    if (y >= 0 && y < canvasH && x >= 0 && x < width) grid[y]![x] = c;
  };
  const sel = nodes[Math.min(selected, nodes.length - 1)];

  // Wires: dotted lines from the centre, brighter to the selected node.
  for (const n of nodes) {
    const steps = Math.max(Math.abs(n.x - cx), Math.abs(n.y - cy) * 2);
    for (let s = 2; s < steps - 1; s += 2) {
      const x = Math.round(cx + ((n.x - cx) * s) / steps);
      const y = Math.round(cy + ((n.y - cy) * s) / steps);
      put(x, y, { ch: "·", color: n === sel ? palette.magenta : palette.rule });
    }
  }
  // Nodes and their labels: right of the node on the right half, left of it on the left.
  for (const n of nodes) {
    const g = GROUP[n.group];
    const on = n === sel;
    put(n.x, n.y, { ch: g.mark, color: on ? palette.magenta : g.color(), bold: true });
    const room = Math.max(6, Math.min(26, n.x >= cx ? width - n.x - 2 : n.x - 1));
    const label = n.label.length > room ? `${n.label.slice(0, room - 1)}…` : n.label;
    const startX = n.x >= cx ? n.x + 2 : n.x - 1 - label.length;
    [...label].forEach((ch, i) => put(startX + i, n.y, { ch, color: on ? palette.text : palette.dim, bg: on ? palette.selectBg : undefined }));
  }
  // The centre: the project.
  const name = ` ${project} `;
  put(cx, cy, { ch: "◉", color: palette.magenta, bold: true });
  [...name].forEach((ch, i) => put(cx + 1 + i, cy, { ch, color: palette.text, bold: true }));

  const rows = grid.map((row) => {
    const runs: Cell[] = [];
    for (const c of row.map((c) => c ?? { ch: " ", color: palette.ground })) {
      const last = runs.at(-1);
      if (last && last.color === c.color && last.bg === c.bg && last.bold === c.bold) last.ch += c.ch;
      else runs.push({ ...c });
    }
    return runs;
  });

  const counts = (["project", "user", "pitfall", "session"] as const).map((g) => [g, nodes.filter((n) => n.group === g).length] as const);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {rows.map((runs, y) => (
        <Text key={y}>
          {runs.map((r, i) => (
            <Text key={i} color={r.color} backgroundColor={r.bg} bold={r.bold}>
              {r.ch}
            </Text>
          ))}
        </Text>
      ))}
      <Text wrap="truncate-end">
        {counts.map(([g, n]) => (
          <Text key={g} color={GROUP[g].color()}>{`${GROUP[g].mark} ${g} ${n}   `}</Text>
        ))}
        <Text color={palette.faint}>{more ? `+${more} not shown   ` : ""}←→↑↓ walk · enter open · esc close</Text>
      </Text>
      <Text color={sel ? palette.text : palette.faint} wrap="truncate-end">
        {sel ? `${sel.label}${sel.detail ? `: ${sel.detail.replace(/\s+/g, " ")}` : ""}` : nodes.length ? "" : "Memory has nothing about this project yet. It fills as you work."}
      </Text>
    </Box>
  );
}
