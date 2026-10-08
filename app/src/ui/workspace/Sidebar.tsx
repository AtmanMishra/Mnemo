/**
 * The sidebar: a strip of pane icons (the open one as a pill with its name)
 * and the pane's rows, with the selection kept in view.
 *
 *   ▐▤ FILES▌ ◈ ▣ ◇ ≡
 *   ▾ src                12
 *     ▸ ui                9
 *     · controller.ts
 */
import React from "react";
import { Box, Text } from "ink";
import { color, palette } from "../theme.ts";
import { PANES, windowFor, type Item, type Pane, type Tone } from "./model.ts";

export const PANE_ICON: Record<Pane, string> = { files: "▤", memory: "◈", sessions: "▣", skills: "◇", logs: "≡" };

export const toneColor = (t: Tone | undefined): string =>
  t === "accent"
    ? palette.magenta
    : t === "link"
      ? palette.cyan
      : t === "memory"
        ? palette.amber
        : t === "muted"
          ? palette.dim
          : t === "faint"
            ? palette.faint
            : t === "ok"
              ? palette.green
              : t === "fail"
                ? palette.red
                : palette.text;

function Tabs({ pane, focused }: { pane: Pane; focused: boolean }): React.ReactElement {
  return (
    <Text>
      {PANES.map((p) =>
        p === pane ? (
          <Text key={p}>
            <Text color={focused ? palette.magenta : palette.faint}>▐</Text>
            <Text color={palette.ground} backgroundColor={focused ? palette.magenta : palette.faint} bold>
              {`${PANE_ICON[p]} ${p.toUpperCase()}`}
            </Text>
            <Text color={focused ? palette.magenta : palette.faint}>▌</Text>
          </Text>
        ) : (
          <Text key={p} color={palette.dim}>
            {` ${PANE_ICON[p]}`}
          </Text>
        ),
      )}
    </Text>
  );
}

function Row({ item, selected, focused, width }: { item: Item; selected: boolean; focused: boolean; width: number }): React.ReactElement {
  const indent = "  ".repeat(item.depth ?? 0);
  const mark = item.kind === "dir" ? (item.open ? "▾ " : "▸ ") : item.kind === "head" ? "" : item.kind === "file" ? "· " : item.kind === "pitfall" ? "! " : "";
  const label = `${indent}${mark}${item.label}`;
  const room = Math.max(0, width - 2);
  const detail = item.detail ? item.detail.replace(/\s+/g, " ") : "";
  const showDetail = item.kind === "dir" || item.kind === "head" ? detail : "";
  const main = label.length + (showDetail ? showDetail.length + 1 : 0) > room ? label.slice(0, room - (showDetail ? showDetail.length + 2 : 1)) + "…" : label;
  const pad = Math.max(0, room - main.length - showDetail.length);
  const fg = item.kind === "head" ? palette.cyan : item.kind === "dir" ? palette.text : toneColor(item.tone);
  return (
    <Text backgroundColor={selected ? color.selectBg : undefined}>
      <Text color={selected ? (focused ? palette.magenta : palette.faint) : palette.ground}>{selected ? "▌" : " "}</Text>
      <Text color={fg} bold={item.kind === "head"}>
        {main}
      </Text>
      <Text>{" ".repeat(pad)}</Text>
      <Text color={palette.faint}>{showDetail}</Text>
      <Text> </Text>
    </Text>
  );
}

export function Sidebar({
  pane,
  items,
  selected,
  focused,
  width,
  height,
}: {
  pane: Pane;
  items: Item[];
  selected: number;
  focused: boolean;
  width: number;
  height: number;
}): React.ReactElement {
  const listHeight = Math.max(1, height - 3);
  const { start, end } = windowFor(items.length, selected, listHeight);
  const sel = items[selected];
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false} borderColor={focused ? palette.magenta : palette.rule}>
      <Tabs pane={pane} focused={focused} />
      <Text color={palette.rule}>{"─".repeat(Math.max(0, width - 1))}</Text>
      <Box flexDirection="column" height={listHeight} overflow="hidden">
        {items.length === 0 ? (
          <Text color={palette.dim}> nothing here yet</Text>
        ) : (
          items.slice(start, end).map((item, i) => <Row key={item.id} item={item} selected={start + i === selected} focused={focused} width={width - 1} />)
        )}
      </Box>
      <Text color={palette.faint} wrap="truncate-end">
        {sel?.detail && sel.kind !== "dir" && sel.kind !== "head" ? ` ${sel.detail.replace(/\s+/g, " ")}` : ` ${items.length ? `${selected + 1}/${items.length}` : ""}`}
      </Text>
    </Box>
  );
}
