/**
 * The main area: the transcript in a scrolling viewport that follows the end
 * until you scroll back, or a preview of what is open in the sidebar.
 */
import React, { useRef } from "react";
import { Box, Text, useBoxMetrics, type DOMElement } from "ink";
import { palette } from "../theme.ts";
import type { Preview } from "./model.ts";
import { toneColor } from "./Sidebar.tsx";

/** A title bar: ── ▐ TITLE ▌ subtitle ────────── */
export function Bar({
  title,
  subtitle,
  width,
  focused,
  extra,
  extraWidth = 0,
}: {
  title: string;
  subtitle?: string;
  width: number;
  focused: boolean;
  /** Drawn after the title (the timeline strip); `extraWidth` is how many cells it takes. */
  extra?: React.ReactNode;
  extraWidth?: number;
}): React.ReactElement {
  const head = ` ${title} `;
  const rest = Math.max(0, width - head.length - (subtitle ? subtitle.length + 3 : 0) - 4 - (extra ? extraWidth + 1 : 0));
  return (
    <Text>
      <Text color={palette.rule}>──</Text>
      <Text color={focused ? palette.magenta : palette.faint}>▐</Text>
      <Text color={palette.ground} backgroundColor={focused ? palette.magenta : palette.faint} bold>
        {head.toUpperCase()}
      </Text>
      <Text color={focused ? palette.magenta : palette.faint}>▌</Text>
      {extra ? (
        <>
          <Text> </Text>
          {extra}
        </>
      ) : null}
      {subtitle ? <Text color={palette.dim}> {subtitle} </Text> : null}
      <Text color={palette.rule}>{"─".repeat(rest)}</Text>
    </Text>
  );
}

/**
 * Children in a viewport of fixed height. `back` is how many rows the view is
 * scrolled up from the end (0 follows new output). Reports how far it can go.
 */
export function Viewport({
  height,
  back,
  onMeasure,
  children,
}: {
  height: number;
  back: number;
  onMeasure?: (contentHeight: number) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const inner = useRef<DOMElement>(null);
  const { height: contentHeight } = useBoxMetrics(inner);
  const max = Math.max(0, contentHeight - height);
  const offset = Math.max(0, max - Math.min(back, max));
  const last = useRef(-1);
  if (onMeasure && last.current !== contentHeight) {
    last.current = contentHeight;
    queueMicrotask(() => onMeasure(contentHeight));
  }
  return (
    <Box height={height} overflow="hidden" flexDirection="column" contentOffsetY={offset}>
      <Box ref={inner} flexDirection="column" flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
}

export function PreviewView({ preview, width, height, back }: { preview: Preview; width: number; height: number; back: number }): React.ReactElement {
  const gutter = Math.max(2, ...preview.lines.map((l) => (l.gutter ?? "").length));
  const top = Math.max(0, Math.min(back, Math.max(0, preview.lines.length - height)));
  const shown = preview.lines.slice(top, top + height);
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {preview.lines.length === 0 ? <Text color={palette.dim}>{preview.subtitle ?? "empty"}</Text> : null}
      {shown.map((l, i) => (
        <Text key={top + i} wrap="truncate-end">
          {l.gutter !== undefined ? <Text color={palette.faint}>{l.gutter.padStart(gutter)} │ </Text> : null}
          <Text color={toneColor(l.tone)}>{l.text.slice(0, Math.max(10, width - gutter - 4))}</Text>
        </Text>
      ))}
    </Box>
  );
}
