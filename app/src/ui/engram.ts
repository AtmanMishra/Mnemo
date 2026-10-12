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

/**
 * Three variations on one piece, each with its own glyphs, inks and order:
 *   hero     the empty transcript (and the site): ASCII glyphs, all four inks,
 *            the figure closing from the middle, a ring of forgetting
 *   boot     the launch: the dither ramp, the figure (Mne and the wordmark)
 *            sweeping in left to right, fast, no ring
 *   welcome  the welcome card: the memory wire's glyphs in amber and cyan
 *   ambient  a whole-terminal backdrop for screens of text, with or without the figure
 */
export const VARIANTS = {
  hero: { ramp: [" ", ".", ":", "+", "x", "*", "#"], inks: ["violet", "cyan", "magenta", "amber"], order: "radial", ripple: true, settle: 2.6, fade: 0.9, rest: 1 },
  boot: { ramp: [" ", " ", "·", "·", "░", "▒"], inks: ["violet", "magenta", "cyan", "violet"], order: "sweep", ripple: false, settle: 0.5, fade: 0.22, rest: 0.6 },
  welcome: { ramp: [" ", "·", "∙", "◦", "◇", "◆"], inks: ["amber", "cyan", "amber", "magenta"], order: "radial", ripple: true, settle: 1.8, fade: 0.6, rest: 1 },
  ambient: { ramp: [" ", " ", "·", "·", ":", "+", "∗"], inks: ["violet", "cyan", "magenta", "amber"], order: "radial", ripple: true, settle: 0.8, fade: 0.4, rest: 0.75 },
} as const satisfies Record<
  string,
  {
    ramp: readonly string[];
    inks: readonly (keyof typeof palette)[];
    order: "radial" | "sweep";
    ripple: boolean;
    settle: number;
    fade: number;
    /** How much of the field stays once the figure has settled: the boot clears to a quiet frame. */
    rest: number;
  }
>;
export type EngramVariant = keyof typeof VARIANTS;

export interface EngramOptions {
  cols: number;
  rows: number;
  /** Seconds since it started. */
  t: number;
  seed?: number;
  /** Seconds for the figure to finish settling (default: the variant's). */
  settle?: number;
  /** False: the figure is settled and the field is still (no motion). */
  animate?: boolean;
  /** What settles out of the field (default: Mne; an empty grid for none). Pixels drawn in Night. */
  art?: Grid;
  /** The field reaches the edges of the frame instead of fading out around the figure. */
  fill?: boolean;
  /** The figure's top row (default: centred), to leave room for text beneath it. */
  top?: number;
  variant?: EngramVariant;
}

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
  const v = VARIANTS[o.variant ?? "hero"];
  const RAMP = v.ramp;
  const seed = o.seed ?? 7;
  const settle = o.settle ?? v.settle;
  const animate = o.animate ?? true;
  const t = animate ? o.t : settle + v.fade + 2;
  const art: Grid = o.art ?? mne.idle;
  const spriteW = art[0]?.length ?? 0;
  const spriteRows = Math.ceil(art.length / 2);
  const ox = Math.floor((cols - spriteW) / 2);
  const oy = o.top ?? Math.floor((rows - spriteRows) / 2);
  const cx = cols / 2;
  const cy = rows / 2;
  const reach = Math.hypot(spriteW / 2, spriteRows);
  const drift = animate ? t * 0.35 : 0;
  const ringAge = animate ? (t - settle - 3) % RIPPLE_EVERY : -1;
  const ringR = v.ripple && ringAge >= 0 && ringAge < RIPPLE_SECONDS ? (ringAge / RIPPLE_SECONDS) * reach * 1.25 : -1;
  const inks = v.inks.map((k) => palette[k]);

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
        // Radial: the figure closes from the middle; sweep: it is written in from the left.
        const order = v.order === "sweep" ? 0.62 * (sx / Math.max(1, spriteW - 1)) : 0.46 * Math.min(1, dist / (reach * 2));
        const delay = settle * (0.12 + order + 0.3 * hash01(x, y, seed));
        p = smooth(0, v.fade, t - delay);
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
      const r = Math.hypot((x - cx) / cx, (y - cy) / cy);
      const edge = o.fill ? 1 - 0.45 * smooth(0.7, 1.4, r) : 1 - smooth(0.5, 1, r);
      const after = settle * 0.9 + v.fade;
      const quiet = 1 - (1 - v.rest) * smooth(after, after + 0.5, t);
      const strength = (inFigure ? 0.35 + 0.65 * p : 0.62 * edge * quiet) * (0.35 + 0.9 * n);
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
