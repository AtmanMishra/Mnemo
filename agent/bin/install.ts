#!/usr/bin/env node
/**
 * `mnemo install` — set Mnemo up, with Nyx pacing while it happens.
 *
 * Installing Mnemo means four slow things: two `npm install`s, a cargo build
 * and a go build. Slow is fine; SILENT and slow is what makes people kill the
 * process and file a bug. So the mascot walks for the whole of it, and each
 * step says what it is doing and how long it took.
 *
 * The art is Nyx, the Bengal — the same mascot tui-go/internal/brand paints.
 * The copy here is standalone (the old Rust TUI lives on the archive/tui-rust
 * branch), so this file is the single source for the installer's own pacing
 * display.
 *
 * Plain Node, no dependencies: an installer that needs installing is not an
 * installer.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// --- brand ---------------------------------------------------------------
// Nyx, same mascot as tui-go/internal/brand. Standalone copy for the
// installer's own display; there is no Rust crate to sync with anymore.
export const WALK_BODY = [
  "..##.......##..##...",
  ".#rr#.....########..",
  ".#R#.....##OO####n#.",
  ".###...############.",
  "..#####R##########..",
  "..###r####R#######..",
  "..################..",
];
export const WALK_LEGS = [
  "..##..##....##..##..",
  "...##..##..##..##...",
  "..##...##...##...##.",
  "...##..##..##..##...",
];
export const TAGLINE = "memory that works like a brain";
export const WORDMARK_SMALL = [
  "##......##..##......##..########..##......##....######",
  "####..####e.####....##e.##eeeeeee.####..####e.##.eeeee##",
  "##ee##.e##e.##ee##..##e.######....##ee##.e##e.##e.....##e",
  "##e..ee.##e.##e..e####e.##eeeee...##e..ee.##e.##e.....##e",
  "##e.....##e.##e....e##e.########..##e.....##e..e######.ee",
  ".ee......ee..ee......ee..eeeeeeee..ee......ee....eeeeee",
];

const RGB = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const INK: Record<string, [string, string]> = {
  "#": ["██", RGB(255, 163, 0)],   // COAT
  R: ["▓▓", RGB(171, 82, 54)],     // ROSETTE
  r: ["▒▒", RGB(171, 82, 54)],
  p: ["▒▒", RGB(255, 204, 170)],   // PEACH
  O: ["◗◖", RGB(0, 228, 54)],      // GREEN eye
  _: ["‾‾", RGB(171, 82, 54)],
  n: ["▄▄", RGB(255, 119, 168)],   // ACCENT nose
  m: ["╰╯", RGB(171, 82, 54)],
  "-": ["──", RGB(95, 87, 79)],
  "/": [" ╱", RGB(95, 87, 79)],
  "\\": ["╲ ", RGB(95, 87, 79)],
  ".": ["  ", ""],
};
const RESET = "\x1b[0m";
const ACCENT = RGB(255, 119, 168);
const MUTED = RGB(154, 142, 151);
const GREEN = RGB(0, 228, 54);
const RED = RGB(255, 0, 77);

/** True when it is safe to animate: a real terminal the user is watching. */
export function canAnimate(env: NodeJS.ProcessEnv = process.env,
                           stream: { isTTY?: boolean } = process.stdout) {
  if (env.NO_COLOR || env.CI) return false;
  return Boolean(stream.isTTY);
}

/** Render marker rows at one cell per marker (no colour) — used by tests. */
export function plain(rows: string[], scale = 2): string[] {
  return rows.map((row) =>
    [...row].map((c) => {
      const wide = (INK[c] ?? INK["."])[0];
      return scale >= 2 ? wide : wide[0];
    }).join(""),
  );
}

function paint(rows: string[]): string[] {
  return rows.map((row) => {
    let out = "";
    for (const c of row) {
      const [glyph, color] = INK[c] ?? INK["."];
      out += color ? color + glyph : glyph;
    }
    return out + RESET;
  });
}

/**
 * One frame of the walk: which rows, and how far from the left.
 *
 * The same arithmetic as `brand::pace` in Rust — out and back, so she turns
 * around at the edge rather than teleporting to the left.
 */
export function pace(tick: number, cols: number) {
  const w = WALK_BODY[0].length * 2;
  const travel = Math.max(1, cols - w);
  const pos = tick % (travel * 2);
  const rightwards = pos < travel;
  const x = rightwards ? pos : travel * 2 - pos;

  let rows = [...WALK_BODY, WALK_LEGS[Math.floor(tick / 3) % WALK_LEGS.length]];
  if (tick % 47 < 2) rows = rows.map((r) => r.replaceAll("O", "_"));
  if (!rightwards) {
    rows = rows.map((r) =>
      [...r].reverse().map((c) => (c === "/" ? "\\" : c === "\\" ? "/" : c)).join(""),
    );
  }
  return { rows, x };
}

// --- the animated runner -------------------------------------------------

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

class Stage {
  out: any;
  height: number;
  tick: number;
  timer: any;
  label = "";

  constructor(out: any = process.stdout) {
    this.out = out;
    this.height = 0;
    this.tick = 0;
    this.timer = null;
  }

  cols() {
    return this.out.columns || 80;
  }

  /** Draw the cat plus a status line, in place. */
  frame(label: string) {
    const { rows, x } = pace(this.tick, this.cols());
    const pad = " ".repeat(x);
    const body = paint(rows).map((r) => pad + r);
    const lines = [...body, `${ACCENT}▊${RESET} ${label}`];
    // rewind over the previous frame, then repaint
    let s = this.height ? `\x1b[${this.height}A` : "";
    for (const l of lines) s += `\x1b[2K${l}\n`;
    this.out.write(s);
    this.height = lines.length;
  }

  start(label: string) {
    this.label = label;
    if (!canAnimate(process.env, this.out)) {
      this.out.write(`  ${label}\n`);
      return;
    }
    this.out.write(HIDE);
    this.frame(label);
    this.timer = setInterval(() => {
      this.tick += 1;
      this.frame(this.label);
    }, 80);
    // an unref'd timer never keeps the process alive on its own
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.height) {
      // erase the animation; the step's own result line replaces it
      this.out.write(`\x1b[${this.height}A`);
      for (let i = 0; i < this.height; i++) this.out.write("\x1b[2K\n");
      this.out.write(`\x1b[${this.height}A`);
      this.height = 0;
    }
    this.out.write(SHOW);
  }
}

function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (d: Buffer | string) => {
      tail = (tail + d).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => resolve({ ok: false, tail: String(e.message) }));
    child.on("exit", (code) => resolve({ ok: code === 0, tail }));
  });
}

/** The steps, in order. Each one is slow enough to be worth watching. */
export function steps(root: string = ROOT) {
  return [
    { label: "installing the agent's dependencies",
      cmd: "npm", args: ["install", "--no-audit", "--no-fund"], cwd: path.join(root, "agent") },
    { label: "installing the harness engine",
      cmd: "npm", args: ["install", "--no-audit", "--no-fund"], cwd: path.join(root, "harness-engine") },
    { label: "building memsrv, the memory sidecar",
      cmd: "cargo", args: ["build", "--release", "--bin", "memsrv"], cwd: path.join(root, "memory-layer") },
    { label: "building mnemo, the terminal interface",
      cmd: "go", args: ["build", "-o", "mnemo", "./cmd/mnemo"], cwd: path.join(root, "tui-go") },
  ];
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const out = process.stdout;
  const colour = canAnimate();
  out.write("\n");
  if (colour) {
    for (const l of paint(WORDMARK_SMALL)) out.write("  " + l + "\n");
  } else {
    out.write("  MNEMO\n");
  }
  out.write(`  ${MUTED}${TAGLINE}${RESET}\n\n`);

  const stage = new Stage(out);
  let failed: { step: { cmd: string; cwd: string }; tail: string } | null = null;
  for (const step of steps()) {
    if (!fs.existsSync(step.cwd)) {
      out.write(`  ${MUTED}skipped${RESET} ${step.label} — ${step.cwd} is not here\n`);
      continue;
    }
    const began = Date.now();
    stage.start(step.label);
    const res = await run(step.cmd, step.args, step.cwd);
    stage.stop();
    const mark = res.ok ? `${GREEN}●${RESET}` : `${RED}●${RESET}`;
    out.write(`  ${mark} ${step.label}  ${MUTED}${secs(Date.now() - began)}${RESET}\n`);
    if (!res.ok) {
      failed = { step, tail: res.tail };
      break;
    }
  }

  if (failed) {
    out.write(`\n  ${RED}${failed.step.cmd} failed${RESET} in ${failed.step.cwd}\n\n`);
    out.write(failed.tail.split("\n").slice(-20).map((l: string) => "    " + l).join("\n") + "\n");
    process.exit(1);
  }

  out.write(`\n  ${GREEN}●${RESET} ready. Run ${ACCENT}mnemo-agent${RESET} in any project.\n`);
  out.write(`    ${MUTED}first launch walks you through choosing a provider and a model.${RESET}\n\n`);
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  process.on("SIGINT", () => {
    process.stdout.write(SHOW + "\n");
    process.exit(130);
  });
  await main();
}
