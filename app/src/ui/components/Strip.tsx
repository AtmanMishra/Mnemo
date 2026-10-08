/**
 * A row of square pixels, one per item: a turn's outcome, a test's result. Each
 * is the upper half of a cell (`▀`), so the strip reads as pixels, not text.
 */
import React from "react";
import { Text } from "ink";
import type { Outcome } from "../activity.ts";
import { palette } from "../theme.ts";

export function outcomeColor(o: Outcome): string {
  return o === "failed" ? palette.red : o === "escalated" ? palette.violet : o === "running" ? palette.magenta : o === "empty" ? palette.faint : palette.green;
}

export function Strip({ colors, max, gap = false, selected }: { colors: readonly string[]; max: number; gap?: boolean; selected?: number }): React.ReactElement {
  const shown = colors.length > max ? colors.slice(colors.length - max) : colors;
  const offset = colors.length - shown.length;
  return (
    <Text>
      {colors.length > max ? <Text color={palette.faint}>…</Text> : null}
      {shown.map((c, i) => (
        <Text key={i} color={c} backgroundColor={offset + i === selected ? palette.selectBg : undefined}>
          {gap ? "▀ " : "▀"}
        </Text>
      ))}
    </Text>
  );
}
