/**
 * Engram, in a terminal: a seeded field of characters that settles into Mne.
 * The same piece as the project site's hero (web/art/ENGRAM.md), drawn on a
 * character grid: free cells are glyphs from a ramp, inked by a drifting noise
 * current; the cells of the sprite settle one by one into half-block pixels
 * (two to a cell, as everywhere in this interface). Every so often a ring of
 * forgetting crosses the figure and its pixels fall back to glyphs for a
 * moment. Pure: a frame is a function of size, time and seed.
 */
import { hash01, valueNoise, type Grid } from "./pixel.ts";
import { mne } from "./pixel.ts";
import { mix, palette } from "./theme.ts";

export interface EngramCell {
  ch: string;
  fg?: string;
  bg?: string;
}

export interface EngramOptions {
  cols: number;
  rows: number;
  /** Seconds since it started. */
  t: number;
  seed?: number;
  /** Seconds for the figure to finish settling. */
  settle?: number;
  /** False: the figure is settled and the field is still (no motion). */
  animate?: boolean;
}

const RAMP = [" ", ".", ":", "+", "x", "*", "#"];
const RIPPLE_EVERY = 13;
const RIPPLE_SECONDS = 2.6;
const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** The smallest size that holds the figure with some field around it. */
export const ENGRAM_MIN = { cols: 26, rows: 11 };

export function engramFrame(o: EngramOptions): EngramCell[][] {
  const { cols, rows } = o;
  const seed = o.seed ?? 7;
  const settle = o.settle ?? 2.6;
  const animate = o.animate ?? true;
  const t = animate ? o.t : settle + 2;
  const art: Grid = mne.idle;
  const spriteW = art[0]!.length;
  const spriteRows = Math.ceil(art.length / 2);
  const ox = Math.floor((cols - spriteW) / 2);
  const oy = Math.floor((rows - spriteRows) / 2);
  const cx = cols / 2;
  const cy = rows / 2;
  const reach = Math.hypot(spriteW / 2, spriteRows);
  const drift = animate ? t * 0.35 : 0;
  const ringAge = animate ? (t - settle - 3) % RIPPLE_EVERY : -1;
  const ringR = ringAge >= 0 && ringAge < RIPPLE_SECONDS ? (ringAge / RIPPLE_SECONDS) * reach * 1.25 : -1;
  const inks = [palette.violet, palette.cyan, palette.magenta, palette.amber];

  const out: EngramCell[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: EngramCell[] = [];
    for (let x = 0; x < cols; x++) {
      const sx = x - ox;
      const sy = y - oy;
      const top = sx >= 0 && sx < spriteW && sy >= 0 && sy < spriteRows ? (art[sy * 2]?.[sx] ?? null) : null;
      const bottom = sx >= 0 && sx < spriteW && sy >= 0 && sy < spriteRows ? (art[sy * 2 + 1]?.[sx] ?? null) : null;
      const inFigure = top !== null || bottom !== null;
      // Cells are about twice as tall as wide: distances count a row as two columns.
      const dist = Math.hypot(x - cx, (y - cy) * 2);
      let p = 0;
      if (inFigure) {
        const delay = settle * (0.12 + 0.46 * Math.min(1, dist / (reach * 2)) + 0.36 * hash01(x, y, seed));
        p = smooth(0, 0.9, t - delay);
        if (ringR >= 0) p *= 1 - Math.max(0, 1 - Math.abs(dist / 2 - ringR) / 1.2);
      }
      if (inFigure && p >= 1) {
        // Settled: half-block pixels, exactly as PixelArt draws them.
        if (top && bottom) row.push(top === bottom ? { ch: "█", fg: top } : { ch: "▀", fg: top, bg: bottom });
        else if (top) row.push({ ch: "▀", fg: top });
        else row.push({ ch: "▄", fg: bottom! });
        continue;
      }
      const n = valueNoise(x * 0.16 + drift, y * 0.32 - drift * 0.6, seed);
      const edge = 1 - smooth(0.5, 1, Math.hypot((x - cx) / cx, (y - cy) / cy));
      const strength = (inFigure ? 0.35 + 0.65 * p : 0.62 * edge) * (0.35 + 0.9 * n);
      const level = Math.min(RAMP.length - 1, Math.floor(strength * RAMP.length));
      if (level <= 0) {
        row.push({ ch: " " });
        continue;
      }
      const inkN = valueNoise(x * 0.07 + 3, y * 0.14, seed + 101) * 6;
      const ink = inkN < inks.length ? inks[Math.floor(inkN)]! : palette.faint;
      // Strength becomes brightness: a faint glyph sinks toward the ground.
      row.push({ ch: RAMP[level]!, fg: mix(palette.ground, ink, Math.min(1, 0.3 + strength * 0.8)) });
    }
    out.push(row);
  }
  return out;
}
