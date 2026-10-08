/**
 * Every colour and glyph the interface uses. Nothing else names a colour, so a
 * palette change is one edit and `DESIGN.md` §2 stays true.
 *
 * The identity is "a memory palace, rendered in pixels": real pixels (two per
 * cell, drawn with a half block and a background colour), ASCII for structure
 * (bracketed tabs, box rules, dither ramps), and a node-and-wire motif for
 * memory. The palette is "Mnemo Night" — a deep ink ground, parchment text,
 * and three signal colours: neuron magenta (the agent), synapse cyan
 * (structure, links), memory amber (anything memory did).
 *
 * Hex values; Ink's chalk downsamples to 256/16 colours and honours NO_COLOR.
 */
export const palette = {
  ground: "#0E0B16",
  panel: "#16111F",
  rule: "#2B2238",
  text: "#EDE4D3",
  dim: "#8A7F94",
  faint: "#4A4157",
  magenta: "#FF5C8A",
  cyan: "#3DDBD9",
  amber: "#FFB547",
  green: "#7BE07B",
  red: "#FF4F5E",
  violet: "#9D7BFF",
  /** Mascot greys and its one warm note. */
  hide: "#A99CC4",
  hideShade: "#7A6D96",
  outline: "#2A2140",
  blush: "#FF8FB1",
  tusk: "#FFF1D6",
} as const;

export const color = {
  accent: palette.magenta,
  accent2: palette.cyan,
  memory: palette.amber,
  thinking: palette.violet,
  success: palette.green,
  warning: palette.amber,
  error: palette.red,
  text: palette.text,
  muted: palette.dim,
  subtle: palette.faint,
  rule: palette.rule,
  /** Backgrounds behind added and removed diff lines. */
  addBg: "#16301F",
  removeBg: "#3A1622",
  /** The sidebar's selected row. */
  selectBg: "#2B2238",
} as const;

export const glyph = {
  user: "❯",
  assistant: "◆",
  thinking: "◇",
  tool: "▣",
  result: "└",
  memory: "◈",
  notice: "▸",
  ok: "✓",
  fail: "✗",
  queued: "↳",
  node: "◆",
  wire: "─",
} as const;

/** The density ramp, lightest to densest: shading, motion, progress. */
export const dither = [" ", "░", "▒", "▓", "█"] as const;

/** A pixel-ish spinner: a dot walking a 2x2 block. */
export const spinnerFrames = ["▖", "▘", "▝", "▗"];

/** What the working line says, rotated while a turn runs. Memory is the brand. */
export const workingVerbs = [
  "Recalling",
  "Thinking",
  "Connecting",
  "Weaving",
  "Reasoning",
  "Consolidating",
  "Remembering",
  "Considering",
];

/** The wordmark's gradient stops, left to right: neuron to synapse. */
export const gradient = [palette.magenta, palette.violet, palette.cyan];

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linear blend between two hex colours, `t` in [0, 1]. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * Math.min(1, Math.max(0, t)));
  return `#${[c(ar, br), c(ag, bg), c(ab, bb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The colour at position `t` along the brand gradient. */
export function gradientAt(t: number): string {
  const stops = gradient.length - 1;
  const x = Math.min(stops, Math.max(0, t * stops));
  const i = Math.min(stops - 1, Math.floor(x));
  return mix(gradient[i]!, gradient[i + 1]!, x - i);
}
