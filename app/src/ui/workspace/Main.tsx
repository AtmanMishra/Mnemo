/**
 * The main area: the transcript in a scrolling viewport that follows the end
 * until you scroll back, or a preview of what is open in the sidebar.
 */
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, type DOMElement } from "ink";
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
 * The height of a box, measured on a timer rather than in the render that
 * produced it. Ink's useBoxMetrics measures after every render and sets state;
 * while an answer streams that chains one update per chunk, and a fast answer
 * runs past React's limit on nested updates. This measures at most once a frame.
 */
export function useMeasuredHeight(ref: React.RefObject<DOMElement | null>): number {
  const [height, setHeight] = useState(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (pending.current) return;
    const measure = () => {
      if (!ref.current) return;
      const h = measureElement(ref.current).height;
      setHeight((prev) => (prev === h ? prev : h));
    };
    // Ink lays the screen out on its own throttled frame (about 33 ms), so a
    // measurement can come before the layout it is after. Measure again once that
    // frame has surely passed: otherwise a box first shown, or shown again (an agent
    // brought forward), can keep a stale height of 0 with nothing to re-render it.
    pending.current = setTimeout(() => {
      measure();
      pending.current = setTimeout(() => {
        pending.current = undefined;
        measure();
      }, 60);
    }, 16);
  });
  useEffect(() => () => clearTimeout(pending.current), []);
  return height;
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
  const contentHeight = useMeasuredHeight(inner);
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
