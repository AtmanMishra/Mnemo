/** Split layouts: every layout of every pane count tiles the area exactly, and four is the most. */
import { test, expect } from "bun:test";
import { defaultLayout, fitsPanes, layoutsFor, nextLayout, PANE_MIN, SPLIT_MAX, splitRects, type SplitLayout } from "../src/ui/layout.ts";

const SIZES: [number, number][] = [[80, 24], [120, 40], [200, 50], [41, 11], [97, 33]];

test("every layout tiles the area exactly: no gaps, no overlap, nothing outside", () => {
  for (let n = 1; n <= SPLIT_MAX; n++)
    for (const layout of layoutsFor(n))
      for (const [W, H] of SIZES) {
        const rects = splitRects(n, layout, W, H);
        expect(rects).toHaveLength(n);
        const cover = Array.from({ length: H }, () => new Array<number>(W).fill(0));
        for (const r of rects) {
          expect(r.w).toBeGreaterThan(0);
          expect(r.h).toBeGreaterThan(0);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(W);
          expect(r.y + r.h).toBeLessThanOrEqual(H);
          for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cover[y]![x]!++;
        }
        const flat = cover.flat();
        expect([n, layout, W, H, flat.every((c) => c === 1)]).toEqual([n, layout, W, H, true]);
      }
});

test("the layouts offered depend on the count, the default is first, and the cycle wraps", () => {
  expect(layoutsFor(2)).toEqual(["cols", "rows"]);
  expect(layoutsFor(3)).toEqual(["grid", "cols", "rows", "main-left"]);
  expect(layoutsFor(4)).toEqual(["grid", "cols", "rows", "main-left"]);
  expect(defaultLayout(2, 120)).toBe("cols");
  expect(defaultLayout(4, 120)).toBe("grid");
  expect(defaultLayout(3, 200)).toBe("cols"); // wide enough for three across
  let l: SplitLayout | undefined = defaultLayout(4, 120);
  const seen: SplitLayout[] = [];
  for (let i = 0; i < 5; i++) seen.push((l = nextLayout(4, l)));
  expect(seen).toEqual(["cols", "rows", "main-left", "grid", "cols"]);
  // A layout that does not exist for the new count falls back to the default's neighbour.
  expect(layoutsFor(2)).toContain(nextLayout(2, "main-left"));
});

test("the shapes: grid puts two across; the odd pane takes the bottom row; main-left gives the first a column", () => {
  expect(splitRects(4, "grid", 100, 40).map((r) => [r.x, r.y, r.w, r.h])).toEqual([[0, 0, 50, 20], [50, 0, 50, 20], [0, 20, 50, 20], [50, 20, 50, 20]]);
  expect(splitRects(3, "grid", 100, 40).map((r) => [r.x, r.y, r.w, r.h])).toEqual([[0, 0, 50, 20], [50, 0, 50, 20], [0, 20, 100, 20]]);
  const main = splitRects(4, "main-left", 100, 40);
  expect(main[0]).toEqual({ x: 0, y: 0, w: 55, h: 40 });
  expect(main.slice(1).every((r) => r.x === 55 && r.w === 45)).toBe(true);
  expect(splitRects(2, "rows", 100, 41).map((r) => r.h)).toEqual([21, 20]);
  expect(splitRects(1, "grid", 100, 40)).toEqual([{ x: 0, y: 0, w: 100, h: 40 }]);
});

test("a split that leaves a pane smaller than the minimum is not used", () => {
  expect(fitsPanes(splitRects(4, "grid", 2 * PANE_MIN.w, 2 * PANE_MIN.h))).toBe(true);
  expect(fitsPanes(splitRects(4, "grid", 2 * PANE_MIN.w - 1, 2 * PANE_MIN.h))).toBe(false);
  expect(fitsPanes(splitRects(4, "rows", 200, 39))).toBe(false); // four rows of nine
  expect(fitsPanes(splitRects(4, "cols", 159, 40))).toBe(false);
});
