import React from "react";
import { Box, Text } from "ink";
import type { Footer as FooterData } from "../../runtime/controller.ts";
import { color, palette } from "../theme.ts";

/** The context window's fill as eight cells of the dither ramp: dim, amber past half, magenta near the limit. */
export function contextGauge(pct: number): { bar: string; tone: string } {
  const cells = 8;
  const v = (Math.max(0, Math.min(100, pct)) / 100) * cells;
  const bar = Array.from({ length: cells }, (_, i) => (v >= i + 1 ? "█" : v > i + 0.66 ? "▓" : v > i + 0.33 ? "▒" : "░")).join("");
  return { bar, tone: pct >= 80 ? palette.magenta : pct >= 50 ? palette.amber : palette.dim };
}

/**
 * Memory on the status line: `off` only when memsrv is not installed; a count;
 * `…` before the first one; `busy` (beside the last count) when it did not answer.
 */
export function memoryText(m: FooterData["memory"]): string {
  if (!m) return "◈ off";
  if (!m.answering) return m.nodes === null ? "◈ busy" : `◈ ${m.nodes} busy`;
  return m.nodes === null ? "◈ …" : `◈ ${m.nodes}`;
}

/**
 * The status line, one row at any width. Facts on the right, by priority: the
 * model always; then memory, the context gauge, the branch, the thinking level
 * and cost, the least important dropped first when the row would not fit. The
 * hint on the left is truncated, and goes when there is no room for it.
 */
export function Footer({
  data,
  hint,
  statuses,
  width = 200,
}: {
  data: FooterData;
  hint: React.ReactNode;
  statuses: readonly [string, string][];
  /** Columns the row has. */
  width?: number;
}): React.ReactElement {
  const pct = data.contextPercent;
  const pctColor = pct === null ? color.muted : pct >= 80 ? color.error : pct >= 50 ? color.warning : color.muted;
  // [priority (lower stays longer), plain width, node]
  const all: [number, number, React.ReactNode][] = [[0, Bun.stringWidth(data.model), <Text key="m" color={color.accent}>{data.model}</Text>]];
  if (data.thinking) all.push([4, 6 + data.thinking.length, <Text key="t">think:{data.thinking}</Text>]);
  if (pct !== null) {
    const g = contextGauge(pct);
    all.push([
      2,
      8 + ` ${Math.round(pct)}%`.length,
      <Text key="c">
        <Text color={g.tone}>{g.bar.replace(/░+$/, "")}</Text>
        <Text color={palette.rule}>{g.bar.match(/░+$/)?.[0] ?? ""}</Text>
        <Text color={pctColor}>{` ${Math.round(pct)}%`}</Text>
      </Text>,
    ]);
  }
  if (data.cost > 0) {
    const cost = `◉ $${data.cost < 0.1 ? data.cost.toFixed(3) : data.cost.toFixed(2)}`;
    all.push([5, Bun.stringWidth(cost), <Text key="$" color={palette.amber}>{cost}</Text>]);
  }
  if (data.branch) all.push([3, 2 + Bun.stringWidth(data.branch), <Text key="b">⎇ {data.branch}</Text>]);
  const mem = memoryText(data.memory);
  const memColor = !data.memory || (data.memory.nodes === null && data.memory.answering) ? color.subtle : data.memory.answering ? color.accent : color.warning;
  all.push([1, Bun.stringWidth(mem), <Text key="mem" color={memColor}>{mem}</Text>]);
  // Keep the most important that fit beside a minimal hint (paddingX 1 each side, a 2-column gap).
  const short = data.mode === "yolo" ? ["⚠ yolo", color.error] : data.mode === "plan" ? ["⏸ plan", color.accent2] : data.mode === "accept-edits" ? ["⏵⏵ edits", color.success] : undefined;
  const budget = width - 2 - (width >= 50 ? 14 : short ? Bun.stringWidth(short[0]!) + 3 : 0);
  const kept = new Set<number>();
  let used = 0;
  for (const i of all.map((_, i) => i).sort((a, b) => all[a]![0] - all[b]![0])) {
    const w = all[i]![1] + (kept.size ? 3 : 0);
    if (used + w > budget && kept.size) continue;
    kept.add(i);
    used += w;
  }
  const parts = all.filter((_, i) => kept.has(i)).map(([, , node]) => node);
  // Narrow, the hint goes; the permission mode never does.
  if (width < 50 && short) parts.unshift(<Text key="mode" color={short[1]}>{short[0]}</Text>);
  const mode =
    data.mode === "accept-edits" ? (
      <Text color={color.success}>⏵⏵ accept edits </Text>
    ) : data.mode === "plan" ? (
      <Text color={color.accent2}>⏸ plan mode </Text>
    ) : data.mode === "yolo" ? (
      <Text color={color.error}>⚠ yolo </Text>
    ) : null;
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} width={width}>
      <Box flexShrink={1} flexGrow={1} display={width >= 50 ? "flex" : "none"}>
        <Text color={color.muted} wrap="truncate-end">
          {mode}
          {mode ? <Text color={color.subtle}>(shift+tab) · </Text> : null}
          {hint}
          {statuses.length > 0 ? <Text color={color.subtle}>{"  " + statuses.map(([, v]) => v).join(" · ")}</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={width >= 50 ? 2 : 0}>
        <Text color={color.muted} wrap="truncate-end">
          {parts.map((p, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <Text color={color.subtle}> · </Text> : null}
              {p}
            </React.Fragment>
          ))}
        </Text>
      </Box>
    </Box>
  );
}
