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
import { PixelArt } from "../components/PixelArt.tsx";
import { mneMini, sprite, type Grid } from "../pixel.ts";

export const PANE_ICON: Record<Pane, string> = { files: "▤", memory: "◈", sessions: "▣", skills: "◇", logs: "≡" };
/** Each pane's tile colour in the tab strip: a row of pixel tiles, the open one with its name. */
const PANE_TILE: Record<Pane, () => string> = {
  files: () => palette.cyan,
  memory: () => palette.amber,
  sessions: () => palette.violet,
  skills: () => palette.green,
  logs: () => palette.dim,
};

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
      {PANES.map((p, i) => {
        const tile = PANE_TILE[p]();
        const on = p === pane;
        return (
          <Text key={p}>
            <Text color={palette.ground} backgroundColor={on ? (focused ? tile : palette.dim) : palette.rule} bold={on}>
              {on ? ` ${PANE_ICON[p]} ${p.toUpperCase()} ` : ` ${PANE_ICON[p]} `}
            </Text>
            {i < PANES.length - 1 ? <Text> </Text> : null}
          </Text>
        );
      })}
    </Text>
  );
}

/** A file's size as four cells of the dither ramp. */
export function sizeBar(weight: number): string {
  const cells = 4;
  const v = Math.max(0, Math.min(1, weight)) * cells;
  return Array.from({ length: cells }, (_, i) => (v >= i + 1 ? "█" : v > i + 0.5 ? "▓" : v > i ? "▒" : "░")).join("");
}

/** Small scenes for empty panes: Mne with what is not there yet. */
const PROPS: Record<Pane, Grid> = {
  files: sprite(["KKK...", "KGGGGK", "KGGGGK", "KKKKKK"], { K: palette.dim, G: palette.rule }),
  memory: sprite(["KKKKK", "KTTTK", "KTTTK", "KKKKK"], { K: palette.amber, T: palette.tusk }),
  sessions: sprite(["..z.z", ".....", "z....", "....."], { z: palette.violet }),
  skills: sprite(["KKKK", "KTTK", "KTTK", "KKKK"], { K: palette.green, T: palette.panel }),
  logs: sprite(["KKKKK", "K...K", "KKKKK", "....."], { K: palette.dim }),
};
const EMPTY: Record<Pane, string> = {
  files: "No files here.",
  memory: "Nothing remembered yet.\nIt fills as you work.",
  sessions: "No past sessions.\nMne is asleep.",
  skills: "No skills yet.\nRepeat a procedure and\nMne offers to save it.",
  logs: "Nothing logged today.",
};

export function EmptyScene({ pane }: { pane: Pane }): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1}>
      <Box>
        <PixelArt grid={mneMini(pane === "sessions" ? palette.dim : palette.hide, pane === "sessions" ? "blink" : "ahead")} />
        <Box marginLeft={1}>
          <PixelArt grid={PROPS[pane]} />
        </Box>
      </Box>
      {EMPTY[pane].split("\n").map((l, i) => (
        <Text key={i} color={i === 0 ? palette.dim : palette.faint}>
          {l}
        </Text>
      ))}
    </Box>
  );
}

function Row({ item, selected, focused, width }: { item: Item; selected: boolean; focused: boolean; width: number }): React.ReactElement {
  const indent = "  ".repeat(item.depth ?? 0);
  const mark = item.kind === "dir" ? (item.open ? "▾ " : "▸ ") : item.kind === "head" ? "" : item.kind === "file" ? (item.badge ? `${item.badge.ch} ` : "· ") : item.kind === "pitfall" ? "! " : "";
  const label = `${indent}${mark}${item.label}`;
  const room = Math.max(0, width - 2);
  const detail = item.detail ? item.detail.replace(/\s+/g, " ") : "";
  const showDetail = item.kind === "dir" || item.kind === "head" ? detail : item.weight !== undefined ? sizeBar(item.weight) : "";
  const main = label.length + (showDetail ? showDetail.length + 1 : 0) > room ? label.slice(0, room - (showDetail ? showDetail.length + 2 : 1)) + "…" : label;
  const pad = Math.max(0, room - main.length - showDetail.length);
  const fg = item.kind === "head" ? palette.cyan : item.kind === "dir" ? palette.text : toneColor(item.badge?.tone ?? item.tone);
  return (
    <Text backgroundColor={selected ? color.selectBg : undefined}>
      <Text color={selected ? (focused ? palette.magenta : palette.faint) : palette.ground}>{selected ? "▌" : " "}</Text>
      <Text color={fg} bold={item.kind === "head"}>
        {main}
      </Text>
      <Text>{" ".repeat(pad)}</Text>
      {item.weight !== undefined && item.kind === "file" ? (
        <Text>
          <Text color={palette.dim}>{showDetail.replace(/░+$/, "")}</Text>
          <Text color={palette.rule}>{showDetail.match(/░+$/)?.[0] ?? ""}</Text>
        </Text>
      ) : (
        <Text color={palette.faint}>{showDetail}</Text>
      )}
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
        {items.length === 0 || (items.length === 1 && items[0]!.kind === "head" && items[0]!.tone === "muted" && items[0]!.id !== "off") ? (
          <EmptyScene pane={pane} />
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
