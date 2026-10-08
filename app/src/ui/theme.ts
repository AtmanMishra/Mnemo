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
const NIGHT = {
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
  /** Backgrounds behind added and removed diff lines, and a selected row. */
  addBg: "#16301F",
  removeBg: "#3A1622",
  selectBg: "#2B2238",
};

export type PaletteKey = keyof typeof NIGHT;
export type ThemeName = "night" | "gameboy" | "paper";

/**
 * The palettes. Night is the identity; the others keep its roles (accent,
 * structure, memory) in another light. Game Boy is four greens, so roles are
 * told apart by value, not hue. Paper is light: it paints its own ground.
 */
export const THEMES: Record<ThemeName, { label: string; paint: boolean; colors: Record<PaletteKey, string> }> = {
  night: { label: "Mnemo Night", paint: false, colors: NIGHT },
  gameboy: {
    label: "Game Boy",
    paint: true,
    colors: {
      ground: "#0F380F",
      panel: "#1E4A1E",
      rule: "#306230",
      text: "#E0F8D0",
      dim: "#8BAC0F",
      faint: "#4F7A28",
      magenta: "#C4F04A",
      cyan: "#9BBC0F",
      amber: "#E0F8D0",
      green: "#C4F04A",
      red: "#E0F8D0",
      violet: "#8BAC0F",
      hide: "#8BAC0F",
      hideShade: "#306230",
      outline: "#0F380F",
      blush: "#C4F04A",
      tusk: "#E0F8D0",
      addBg: "#306230",
      removeBg: "#1E4A1E",
      selectBg: "#306230",
    },
  },
  paper: {
    label: "Paper",
    paint: true,
    colors: {
      ground: "#F4EEE2",
      panel: "#EAE2D2",
      rule: "#D8CDB8",
      text: "#2A2433",
      dim: "#6E6478",
      faint: "#A79DAF",
      magenta: "#D6336C",
      cyan: "#0F8C8A",
      amber: "#B86E00",
      green: "#2F8F3A",
      red: "#C62835",
      violet: "#6A4BD8",
      hide: "#7D7096",
      hideShade: "#5C5176",
      outline: "#2A2140",
      blush: "#E86A94",
      tusk: "#FFFDF7",
      addBg: "#DDF0DC",
      removeBg: "#F6DCE2",
      selectBg: "#E2D7F0",
    },
  },
};

/** The current palette. Mutated in place by `applyTheme`, so read it at render time. */
export const palette: Record<PaletteKey, string> = { ...NIGHT };

export const color = {
  accent: "",
  accent2: "",
  memory: "",
  thinking: "",
  success: "",
  warning: "",
  error: "",
  text: "",
  muted: "",
  subtle: "",
  rule: "",
  addBg: "",
  removeBg: "",
  selectBg: "",
};

/** The wordmark's gradient stops, left to right: neuron to synapse. */
export const gradient: string[] = [];

let current: ThemeName = "night";
/** Night colour → this theme's: pixel art is drawn in Night and translated. */
let remap = new Map<string, string>();

export function applyTheme(name: ThemeName): void {
  const t = THEMES[name] ?? THEMES.night;
  current = name in THEMES ? name : "night";
  Object.assign(palette, t.colors);
  Object.assign(color, {
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
    addBg: palette.addBg,
    removeBg: palette.removeBg,
    selectBg: palette.selectBg,
  });
  gradient.splice(0, gradient.length, palette.magenta, palette.violet, palette.cyan);
  remap = new Map((Object.keys(NIGHT) as PaletteKey[]).map((k) => [NIGHT[k].toLowerCase(), t.colors[k]]));
}
applyTheme("night");

export const themeName = (): ThemeName => current;
/** Whether the interface paints its own background (light and non-Night themes). */
export const themePaints = (): boolean => THEMES[current].paint;
/** A colour drawn in Night, in the current theme. */
export function themed(hex: string): string {
  return current === "night" ? hex : (remap.get(hex.toLowerCase()) ?? hex);
}

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
