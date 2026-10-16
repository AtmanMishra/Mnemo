/**
 * Where the panes of a split go. Pure: a count, a layout and a size in, one
 * rectangle per pane out, so every layout can be tested at any size.
 *
 * At most four panes are ever shown (`SPLIT_MAX`); when more agents are related
 * the rest are one key away in the agents page. A layout is offered only when it
 * means something for the count:
 *
 *   2   cols  rows
 *   3   grid  cols  rows  main-left
 *   4   grid  cols  rows  main-left
 *
 *   cols       side by side           rows       stacked
 *   grid       two across, the odd pane takes the bottom row
 *   main-left  the first pane is large on the left, the others stack beside it
 */
export const SPLIT_MAX = 4;

export type SplitLayout = "grid" | "cols" | "rows" | "main-left";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const LAYOUT_LABEL: Record<SplitLayout, string> = {
  grid: "grid",
  cols: "columns",
  rows: "rows",
  "main-left": "main + side",
};

/** The layouts that make sense for `n` panes, the default first. */
export function layoutsFor(n: number): SplitLayout[] {
  if (n <= 1) return ["cols"];
  if (n === 2) return ["cols", "rows"];
  return ["grid", "cols", "rows", "main-left"];
}

/** The layout a split starts in: wide terminals put three side by side. */
export function defaultLayout(n: number, columns: number): SplitLayout {
  if (n === 3 && columns >= 180) return "cols";
  return layoutsFor(n)[0]!;
}

/** The next layout after `current` for `n` panes; a layout that no longer fits the count falls back to the default. */
export function nextLayout(n: number, current: SplitLayout | undefined, delta = 1): SplitLayout {
  const all = layoutsFor(n);
  const at = current ? all.indexOf(current) : -1;
  return all[(at + delta + all.length) % all.length]!;
}

/** `total` cells divided into `n` parts, the remainder spread from the front. */
function divide(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

function row(widths: number[], y: number, h: number, x0 = 0): Rect[] {
  let x = x0;
  return widths.map((w) => {
    const r = { x, y, w, h };
    x += w;
    return r;
  });
}

function column(heights: number[], x: number, w: number, y0 = 0): Rect[] {
  let y = y0;
  return heights.map((h) => {
    const r = { x, y, w, h };
    y += h;
    return r;
  });
}

/** One rectangle per pane in a `width`×`height` area; the rectangles tile it exactly. */
export function splitRects(n: number, layout: SplitLayout, width: number, height: number): Rect[] {
  if (n <= 1) return [{ x: 0, y: 0, w: width, h: height }];
  if (layout === "rows") return column(divide(height, n), 0, width);
  if (layout === "main-left" && n >= 3) {
    const main = Math.floor(width * 0.55);
    return [{ x: 0, y: 0, w: main, h: height }, ...column(divide(height, n - 1), main, width - main)];
  }
  if (layout === "grid" && n >= 3) {
    const top = Math.ceil(n / 2);
    const rowsH = divide(height, 2);
    // Two across the top; below, the remaining one or two (a single pane takes the whole row).
    return [...row(divide(width, top), 0, rowsH[0]!), ...row(divide(width, n - top), rowsH[0]!, rowsH[1]!)];
  }
  return row(divide(width, n), 0, height);
}

export const PANE_MIN = { w: 40, h: 10 };

/** Whether every pane is big enough to use. */
export function fitsPanes(rects: readonly Rect[]): boolean {
  return rects.every((r) => r.w >= PANE_MIN.w && r.h >= PANE_MIN.h);
}
