/**
 * The palette, and the two functions that make colour safe to use.
 *
 * Two problems to solve at once, and they have to be solved together:
 *
 *  1. **Everything is the same weight.** Without colour, a banner, a mascot, a
 *     status bar and a prompt all read as one flat mass — which is what "this
 *     looks like debug output" means. Colour is not decoration here; it is the
 *     only thing that separates chrome from content in a monospace grid.
 *  2. **Escape codes are invisible but not weightless.** Every layout in this app
 *     measures text by character count. Colour a string and its `.length` grows
 *     by ten characters per run while its *visible* width does not change, so
 *     padding, wrapping and centring all break silently — the worst kind of
 *     break, because it looks like a layout bug and is actually a measurement
 *     bug.
 *
 * So: `width()` and `slice()` measure and cut what is *visible*, and every
 * layout function uses them instead of `.length`. Then colour can be applied
 * anywhere without moving a single pixel.
 *
 * The register is Mnemo's: a Greek agent built out of pixels, drawn from the
 * PICO-8 palette `tui-go` used, so the two interfaces are recognisably the same
 * creature even while one is being retired.
 */
const ESC = "\u001b[";

/**
 * PICO-8's sixteen, as 256-colour codes.
 *
 * Not the 0–15 range: those render as the terminal's own base palette, where
 * "peach" comes out white and "red" is the system red — and PICO-8 is a specific
 * set of colours, not a set of names. These are the nearest xterm-256 entries to
 * the actual PICO-8 values, which is what makes the art look like pixel art
 * rather than like coloured text.
 */
const COLOURS = {
  black: 232, // #000000
  darkBlue: 24, // #1d2b53
  darkPurple: 55, // #7e2553
  darkGreen: 29, // #008751
  brown: 94, // #ab5236
  darkGrey: 240, // #5f574f
  lightGrey: 250, // #c2c3c7
  white: 255, // #fff1e8
  red: 203, // #ff004d
  orange: 215, // #ffa300
  yellow: 227, // #ffec27
  green: 113, // #00e436
  blue: 111, // #29adff
  lavender: 183, // #83769c
  pink: 218, // #ff77a8
  peach: 223, // #ffccaa
} as const;

type ColourName = keyof typeof COLOURS;

/** What each part of the interface is painted with. */
export const ROLES = {
  /** The wordmark and its mark: Mnemo's own colour, used nowhere else. */
  wordmark: "peach",
  /** Body of the mascot. */
  coat: "lightGrey",
  /** Light detail — a plate, a band, the wordmark's lip. */
  detail: "darkGrey",
  /** The one bright mark on a figure. */
  accent: "red",
  /** Secondary text: hints, counts, the status bar. */
  muted: "darkGrey",
  /** A user's own words. */
  user: "lightGrey",
  /** The agent speaking. */
  agent: "white",
  /** Something went right: a tool that worked, a question answered. */
  ok: "green",
  /** Something went wrong. The only red that means a fault. */
  err: "red",
  /** A question waiting on the reader, and the answers they can give. */
  ask: "yellow",
  /** A tool call, while it runs. */
  tool: "blue",
} satisfies Record<string, ColourName>;

export type Role = keyof typeof ROLES;

export interface Painter {
  /** Colour a string. Returns it unchanged when colour is off. */
  paint(role: Role, text: string): string;
  /** True when colour is on — so callers can skip building styled strings. */
  readonly colour: boolean;
}

/**
 * Whether to colour at all.
 *
 * Off when the output is not a terminal, when `NO_COLOR` is set (the convention
 * every serious CLI honours), or when `TERM=dumb`. This is why our own test
 * captures came back clean while a real terminal gets colour: the same rule that
 * keeps logs readable also keeps tests deterministic.
 */
export function wantsColour(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (!isTty) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return true;
}

export function makePainter(enable: boolean): Painter {
  return {
    colour: enable,
    paint(role, text) {
      if (!enable || text === "") return text;
      const code = COLOURS[ROLES[role]];
      return `${ESC}38;5;${code}m${text}${ESC}0m`;
    },
  };
}

/** A painter that never colours: the default in tests and when piped. */
export const PLAIN: Painter = makePainter(false);

const ANSI = new RegExp(`${"\u001b"}\\[[0-9;]*[A-Za-z]`, "g");

/** The string with every escape removed — what a reader actually sees. */
export function strip(text: string): string {
  return text.replace(ANSI, "");
}

/** How many cells the text occupies, escapes not counted. */
export function width(text: string): number {
  return strip(text).length;
}

/** Cut to a visible width without splitting an escape sequence. */
export function slice(text: string, cols: number): string {
  if (width(text) <= cols) return text;
  // A reset is only owed to text that was coloured. Appending one to plain text
  // changes the bytes of every truncated line — which is how a colour change
  // quietly became a layout change for anything comparing strings.
  const coloured = text.includes("\u001b");
  let seen = 0;
  let out = "";
  let i = 0;
  while (i < text.length && seen < cols) {
    if (text[i] === "\u001b") {
      const match = new RegExp(`^${"\u001b"}\\[[0-9;]*[A-Za-z]`).exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += text[i];
    seen += 1;
    i += 1;
  }
  return coloured ? `${out}${ESC}0m` : out;
}
