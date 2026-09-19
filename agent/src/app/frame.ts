/**
 * The frame a run paints before it does anything else.
 *
 * This is the app's first screen, and it exists for three reasons that are all
 * the same reason:
 *
 *  1. **A first run must say what to do.** The Go interface taught this the
 *     hard way — a person installed it, saw an empty screen, and reported
 *     "/login is not working" about a command that was working and telling them
 *     what to type in a status line that erased itself after five seconds.
 *     Instructions belong where they stay.
 *  2. **A working machine must not be onboarded.** Someone with a provider and
 *     a model gets a status line, not a numbered setup list. Being greeted with
 *     a setup wizard every launch is its own kind of broken.
 *  3. **It must be renderable with no model, no key, and no agent.** That is
 *     what makes it checkable: `mnemo --dump` prints this and exits, so every
 *     claim about the layout is a command someone else can run.
 */
import type { DoctorLine } from "./doctor.ts";

export interface BootFrameOptions {
  rows: number;
  cols: number;
  runtime: string;
  home: string;
  provider?: string;
  model?: string;
  memsrv: boolean;
  kernel: boolean;
}

/** A line that fits the width it was given; the banner and rules pad themselves. */
function fit(text: string, cols: number): string {
  if (text.length <= cols) return text;
  return text.slice(0, Math.max(0, cols - 1)) + "…";
}

function rule(label: string, cols: number, right = ""): string {
  const head = `▀▀▐ ${label} ▌`;
  const tail = right ? ` ${right} ` : "";
  const fill = Math.max(0, cols - head.length - tail.length);
  return `${head}${"▀".repeat(fill)}${tail}`;
}

function banner(cols: number, runtime: string): string {
  const head = "▚ MNEMO ";
  const tail = ` ${runtime} `;
  const fill = Math.max(0, cols - head.length - tail.length);
  return `${head}${"─".repeat(fill)}${tail}`;
}

/**
 * The dots-and-steps body a first run needs, or the one-line status a configured
 * run gets. Both return the same shape so the caller can compose them.
 */
function setupSteps(cols: number): string[] {
  return [
    "  nothing is set up yet — a terminal coding agent whose memory persists",
    "  between sessions, so it does not start from zero every time.",
    "",
    "  1. /login   pick a provider and paste its API key (bare, it lists them)",
    "  2. /model   choose the default model from what that key can run",
    "  3. ask for something — the agent reads, edits and runs commands, asking first",
    "",
  ].map((l) => fit(l, cols));
}

function statusLine(o: BootFrameOptions, cols: number): string[] {
  const model = o.model ? ` / ${o.model}` : "";
  return [
    fit(`  ready. ${o.provider}${model}`, cols),
    "",
  ];
}

/** Renders one boot frame. Pure: same options, same string, no I/O. */
export function renderBootFrame(o: BootFrameOptions): string {
  const cols = o.cols;
  const rows: string[] = [];

  rows.push(banner(cols, o.runtime));
  rows.push("");
  rows.push(rule("TRANSCRIPT", cols));

  if (!o.provider) {
    rows.push(...setupSteps(cols));
  } else {
    rows.push(...statusLine(o, cols));
  }

  const facts = [
    `memory sidecar ${o.memsrv ? "on" : "off"}`,
    `ipy kernel ${o.kernel ? "on" : "off"}`,
  ].join("   ·   ");
  rows.push(fit(`  ${facts}`, cols));
  rows.push(fit(`  home ${o.home}`, cols));

  // The frame is a window: keep the top (identity and instructions) and drop
  // the tail rather than letting it overflow the height it was given.
  return rows.slice(0, Math.max(1, o.rows - 1)).join("\n");
}

/** The same facts a doctor run prints, as the frame's footer — one source per fact. */
export function frameFromDoctor(o: BootFrameOptions, lines: DoctorLine[]): string {
  const provider = lines.find((l) => l.name === "provider");
  const memsrv = lines.find((l) => l.name === "memory sidecar");
  const kernel = lines.find((l) => l.name === "ipy kernel");
  return renderBootFrame({
    ...o,
    provider: provider?.ok ? provider.detail : undefined,
    memsrv: memsrv?.ok ?? false,
    kernel: kernel?.ok ?? false,
  });
}
