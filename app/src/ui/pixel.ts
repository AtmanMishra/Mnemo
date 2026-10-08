/**
 * Pixels in a terminal.
 *
 * A cell is about twice as tall as it is wide, so it holds two square pixels
 * stacked: the upper one is the foreground of `▀`, the lower one its
 * background. A grid of colours (null = the terminal's own ground) becomes
 * rows of cells, and runs of identical cells are merged so a frame costs a
 * few dozen spans, not one per pixel. Pure: the components draw what this
 * returns, and tests read it without a terminal.
 */
import { gradientAt, mix, palette } from "./theme.ts";

export type Pixel = string | null;
export type Grid = Pixel[][];

export interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
}

/** Two pixel rows → one row of cells. */
export function toCells(grid: Grid): Cell[][] {
  const out: Cell[][] = [];
  const width = Math.max(0, ...grid.map((r) => r.length));
  for (let y = 0; y < grid.length; y += 2) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x++) {
      const top = grid[y]?.[x] ?? null;
      const bottom = grid[y + 1]?.[x] ?? null;
      if (!top && !bottom) row.push({ ch: " " });
      else if (top && !bottom) row.push({ ch: "▀", fg: top });
      else if (!top && bottom) row.push({ ch: "▄", fg: bottom });
      else if (top === bottom) row.push({ ch: "█", fg: top! });
      else row.push({ ch: "▀", fg: top!, bg: bottom! });
    }
    out.push(row);
  }
  return out;
}

export interface Run {
  text: string;
  fg?: string;
  bg?: string;
}

/** Merge neighbouring cells that look the same, and drop trailing blanks. */
export function toRuns(cells: Cell[][]): Run[][] {
  return cells.map((row) => {
    let end = row.length;
    while (end > 0 && row[end - 1]!.ch === " " && !row[end - 1]!.bg) end--;
    const runs: Run[] = [];
    for (const c of row.slice(0, end)) {
      const last = runs.at(-1);
      if (last && last.fg === c.fg && last.bg === c.bg) last.text += c.ch;
      else runs.push({ text: c.ch, fg: c.fg, bg: c.bg });
    }
    return runs;
  });
}

/** A sprite as text: one character per pixel, mapped through a legend. */
export function sprite(rows: readonly string[], legend: Record<string, string>): Grid {
  return rows.map((r) => [...r].map((ch) => legend[ch] ?? null));
}

// ── the pixel font: 5×5, capitals and digits that the brand uses ────────────

const FONT: Record<string, string[]> = {
  M: ["X...X", "XX.XX", "X.X.X", "X...X", "X...X"],
  N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X"],
  E: ["XXXXX", "X....", "XXXX.", "X....", "XXXXX"],
  O: [".XXX.", "X...X", "X...X", "X...X", ".XXX."],
  " ": [".....", ".....", ".....", ".....", "....."],
};

/**
 * Text in the pixel font, painted along the brand gradient, with a one-pixel
 * drop shadow down and right — the shadow is what makes flat pixels read as
 * a sign rather than as a printout.
 */
export function pixelText(text: string, o: { shadow?: string; from?: number; to?: number } = {}): Grid {
  const letters = [...text.toUpperCase()].map((ch) => FONT[ch] ?? FONT[" "]!);
  const width = letters.length * 6 - 1 + 1;
  const height = 5 + 1;
  const grid: Grid = Array.from({ length: height }, () => Array<Pixel>(width).fill(null));
  const shadow = o.shadow ?? palette.outline;
  const plot = (x: number, y: number, c: string) => {
    if (y < height && x < width) grid[y]![x] = c;
  };
  letters.forEach((g, i) => {
    g.forEach((row, y) =>
      [...row].forEach((p, x) => {
        if (p === "X") plot(i * 6 + x + 1, y + 1, shadow);
      }),
    );
  });
  letters.forEach((g, i) => {
    g.forEach((row, y) =>
      [...row].forEach((p, x) => {
        const gx = i * 6 + x;
        const t = (o.from ?? 0) + ((o.to ?? 1) - (o.from ?? 0)) * (gx / Math.max(1, width - 2));
        if (p === "X") plot(gx, y, gradientAt(t));
      }),
    );
  });
  return grid;
}

// ── Mne, the elephant: elephants never forget ──────────────────────────────

const MNE_LEGEND: Record<string, string> = {
  K: palette.outline,
  G: palette.hide,
  g: palette.hideShade,
  P: palette.blush,
  T: palette.tusk,
  E: palette.ground,
  M: palette.amber,
  m: mix(palette.amber, palette.ground, 0.45),
};

/** Front-facing: big ears, a trunk with a curl, eyes as holes in the hide. */
const MNE_IDLE = [
  "..................",
  "..................",
  "......KKKKKK......",
  ".....KGGGGGGK.....",
  "..KKKGGGGGGGGKKK..",
  ".KgggKGGGGGGKgggK.",
  "KggPgKGEGGEGKgPggK",
  "KgPPgKGGGGGGKgPPgK",
  "KgPPgGGGGGGGGgPPgK",
  "KggggGGGGGGGGggggK",
  ".KgggKGGGGGGKgggK.",
  "..KKKTKGGGGKTKKK..",
  ".....TKGGGGKT.....",
  "......KGGGGK......",
  ".......KGGK.......",
  ".......KGGK.......",
  "......KGGGK.......",
  "......KGKK........",
]

const blink = (rows: string[]) => rows.map((r) => r.replace(/E/g, "g"));
const withSpark = (rows: string[], spark: string[]) => rows.map((r, i) => (i < spark.length ? mergeRow(r, spark[i]!) : r));
function mergeRow(base: string, over: string): string {
  return [...base].map((ch, i) => (over[i] && over[i] !== "." ? over[i]! : ch)).join("");
}

/** A thought forming above the head: memory amber. */
const SPARK = [".......m.M.m......", "........MMM......."];

export const mne = {
  idle: sprite(MNE_IDLE, MNE_LEGEND),
  blink: sprite(blink(MNE_IDLE), MNE_LEGEND),
  think: sprite(withSpark(MNE_IDLE, SPARK), MNE_LEGEND),
  width: 18,
  /** Cells tall (two pixels per cell). */
  height: MNE_IDLE.length / 2,
};

// ── motion helpers ──────────────────────────────────────────────────────────

/** A deterministic pseudo-random number per (x, y, seed): noise that does not flicker between renders. */
export function hash01(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * A grid resolving out of noise: at `t` = 0 every pixel is static, at 1 the
 * picture is clean. Each pixel settles at its own moment, so the image
 * condenses rather than fades — the boot's "a memory coming back".
 */
export function resolve(grid: Grid, t: number, seed = 7): Grid {
  return grid.map((row, y) =>
    row.map((p, x) => {
      const at = hash01(x, y, seed);
      if (t >= 1 || at < t * 1.15 - 0.1) return p;
      // Not yet settled: static in the palette's dim tones, sparser as t grows.
      const n = hash01(x, y, seed + Math.floor(t * 30));
      if (n < 0.55 - t * 0.4) return null;
      return n < 0.8 ? palette.faint : n < 0.93 ? palette.rule : p ? mix(p, palette.ground, 0.6) : palette.faint;
    }),
  );
}

/** Place `art` on a blank grid of the given size at (x, y). */
export function place(w: number, h: number, items: { grid: Grid; x: number; y: number }[]): Grid {
  const out: Grid = Array.from({ length: h }, () => Array<Pixel>(w).fill(null));
  for (const { grid, x, y } of items)
    grid.forEach((row, dy) =>
      row.forEach((p, dx) => {
        if (p && out[y + dy] && x + dx >= 0 && x + dx < w) out[y + dy]![x + dx] = p;
      }),
    );
  return out;
}
