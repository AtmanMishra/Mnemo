/**
 * Every colour and glyph the interface uses. Nothing else names a colour, so a
 * palette change is one edit and `DESIGN.md` §2 stays true.
 *
 * Hex values; Ink's chalk downsamples to 256/16 colours and honours NO_COLOR.
 */
export const color = {
  accent: "#B794F6",
  accent2: "#7DD3FC",
  success: "#86EFAC",
  warning: "#FCD34D",
  error: "#FCA5A5",
  muted: "#8B8B96",
  subtle: "#4A4A55",
  /** Backgrounds behind added and removed diff lines. */
  addBg: "#1C3326",
  removeBg: "#3A1E24",
} as const;

export const glyph = {
  user: "❯",
  assistant: "●",
  thinking: "✻",
  tool: "◆",
  result: "⎿",
  memory: "◈",
  notice: "▸",
  ok: "✓",
  fail: "✗",
  queued: "↳",
} as const;

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

/** The wordmark's gradient stops, left to right. */
export const gradient = [color.accent, "#A5A8F8", "#93BCFA", color.accent2];

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
