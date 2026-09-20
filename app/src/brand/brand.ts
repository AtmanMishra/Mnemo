/**
 * The creatures, and the ink they are drawn with.
 *
 * Mnemo is Mnemosyne: the theme is Greek, built out of pixels and ASCII. This is
 * that register brought over from `tui-go/internal/brand` rather than invented
 * again — the same pixel vocabulary, the same first creature — because an
 * identity that is redrawn from scratch at every port is not an identity.
 *
 * Two rules from the original that are not style preferences:
 *
 *  1. **The mascot is drawn at two cells per mark.** A terminal cell is about
 *     twice as tall as it is wide, so one cell per mark makes a squashed 2×1
 *     rectangle; two makes a square 2×2 pixel, which is what makes the figure
 *     read as pixel art instead of as stretched text.
 *  2. **An eye is a hole in the body, never a drawn shape.** Drawn eyes plus a
 *     mouth at this size read as a glare with teeth. Negative space is calm,
 *     costs no colour, and survives any background.
 */
import { fit } from "../frame/frame.ts";
import { PLAIN, type Painter, type Role } from "../theme/theme.ts";

/** What one art character draws: at mascot scale, and at wordmark scale. */
export interface Pixel {
  wide: string;
  narrow: string;
  /** What it is painted with — the whole reason the art reads as a figure. */
  role?: Role;
}

export const PIXELS: Record<string, Pixel> = {
  "#": { wide: "██", narrow: "█", role: "coat" }, // the body
  u: { wide: "▀▀", narrow: "▀", role: "coat" }, // a raised limb, a wing up
  v: { wide: "▄▄", narrow: "▄", role: "coat" }, // a thin leg, a claw held low
  r: { wide: "▒▒", narrow: "▒", role: "detail" }, // detail, light — a plate, a band
  R: { wide: "▓▓", narrow: "▓", role: "detail" }, // detail, heavy — a stripe
  p: { wide: "▒▒", narrow: "▒", role: "accent" }, // the one highlight
  n: { wide: "▄▄", narrow: "▄", role: "accent" }, // THE accent: one run per creature
  O: { wide: "  ", narrow: " " }, // an eye: a hole, never a drawn shape
  _: { wide: "██", narrow: "█", role: "coat" }, // what a blink fills the hole with
};

/**
 * Karkinos — the crab, the one that holds on.
 *
 * Memory is the thing that holds on, so the crab is the first figure. His claws
 * are held one mark low (`v` above the body) so they read as claws about to
 * close rather than as horns, and the mouth is the single accent: the one drawn
 * pixel on the line that is not the body is the one that speaks.
 */
export const KARKINOS = {
  name: "Karkinos",
  idle: ["v...v", "#####", "#O#O#", "##n##", "v.v.v"],
  bob: ["#...#", "#####", "#O#O#", "##n##", "#.#.#"],
  think: ["v...v", "#####", "#O#O#", "##n##", "#####"],
} as const;

export type Frame = keyof Omit<typeof KARKINOS, "name">;

/**
 * One grid of art, drawn at a scale.
 *
 * An unknown marker draws as nothing — the same rule the original kept. Silence
 * is the right failure: a marker that drew a visible block would put a shape in
 * the figure that nobody asked for, and it would be found by looking rather than
 * by any check.
 */
export function paint(art: readonly string[], scale: 1 | 2 = 2, painter: Painter = PLAIN): string[] {
  return art.map((row) => {
    // Consecutive marks of one role are painted as a single run: a figure is ten
    // cells wide and a figure with an escape per cell is mostly escape.
    const runs: Array<{ role: Role | undefined; glyphs: string }> = [];
    for (const marker of [...row]) {
      const pixel = PIXELS[marker];
      // An undefined mark draws as its own width in *spaces*, not as nothing.
      // The gaps between the claws are undefined marks: collapsing them to zero
      // touches the claws to the body and turns the crab into a lozenge. Silence
      // here means "nothing drawn", and nothing drawn still occupies its cell —
      // the same reason an eye is a hole rather than a shape.
      const glyphs = pixel?.[scale === 2 ? "wide" : "narrow"] ?? (scale === 2 ? "  " : " ");
      const role = pixel?.role;
      const last = runs[runs.length - 1];
      if (last && last.role === role) last.glyphs += glyphs;
      else runs.push({ role, glyphs });
    }
    return runs.map((run) => (run.role ? painter.paint(run.role, run.glyphs) : run.glyphs)).join("");
  });
}

/** The width a figure occupies, in cells. */
export function widthOf(art: readonly string[], scale: 1 | 2 = 2): number {
  const first = art[0];
  if (!first) return 0;
  const one = PIXELS[first[0] ?? ""]?.[scale === 2 ? "wide" : "narrow"] ?? "";
  return first.length * one.length;
}

/**
 * The width below which the welcome shows prose only.
 *
 * The figure is ten cells and the tagline under it is longer; a welcome whose
 * tagline is cut in half is worse than a welcome with no figure at all. This is
 * the number that decides which of those two the reader gets.
 */
export const MIN_FIGURE_COLS = 36;

export const TAGLINE = "a terminal agent whose memory persists";

/** Centre a block of art in the given width, padding both sides. */
function centre(lines: readonly string[], cols: number): string[] {
  return lines.map((line) => {
    const pad = Math.max(0, Math.floor((cols - widthOfString(line)) / 2));
    return fit(`${" ".repeat(pad)}${line}`, cols);
  });
}

/** Visible width, counting the half-blocks as the one cell each they occupy. */
function widthOfString(line: string): number {
  return [...line].length;
}

/**
 * The figure and its tagline, centred, or nothing at all when the terminal is
 * too narrow to show it whole.
 */
export function splash(cols: number, frame: Frame = "idle", painter: Painter = PLAIN): string[] {
  const art = paint(KARKINOS[frame], 2, painter);
  if (cols < MIN_FIGURE_COLS) return [];
  return [...centre(art, cols), ...centre([TAGLINE], cols), ""];
}
