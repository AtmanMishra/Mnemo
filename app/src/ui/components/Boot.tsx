/**
 * The launch sequence, every time Mnemo opens (about 1.6 s; any key skips):
 *
 *   recall   Mne and the wordmark settle out of a drifting field of dither
 *            glyphs, written in from the left — Engram's boot variation
 *            (../engram.ts): a memory coming back
 *   scan     a magenta scanline sweeps the picture
 *   wire     the memory wire draws itself, ◆──◆──◆, and the tagline types
 *   stats    what memory holds counts up; Mne blinks; done
 *
 * The frame is a pure function of time (`bootFrame`), so a test or a snapshot
 * can ask for any moment. Without motion — `--no-motion`, a dump, a pipe — the
 * last frame is shown and the sequence ends at once. A terminal too small for
 * the picture gets the wordmark in text.
 */
import React, { useContext, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { mix, palette } from "../theme.ts";
import { mne, pixelText, place, type Grid } from "../pixel.ts";
import { engramFrame, type EngramCell } from "../engram.ts";
import { EngramCells } from "./Engram.tsx";
import { MotionContext } from "./motion.ts";

export interface BootInfo {
  version: string;
  /** What memory holds, counted up in the last phase; absent when memory is off. */
  stats?: { memories: number; skills: number; sessions: number };
  columns: number;
  rows: number;
}

export const BOOT_MS = 1600;
const TAGLINE = "a coding agent that remembers";

/** The picture: Mne on the left, the wordmark beside, both on one pixel canvas. */
function scene(blinking: boolean, scanRow?: number): Grid {
  const word = pixelText("MNEMO");
  const art = blinking ? mne.blink : mne.idle;
  const w = mne.width + 4 + word[0]!.length;
  const h = 18;
  const grid = place(w, h, [
    { grid: art, x: 0, y: 0 },
    { grid: word, x: mne.width + 4, y: 7 },
  ]);
  if (scanRow === undefined) return grid;
  // The scanline: a band of pixels pulled toward magenta, a fainter trail above it.
  return grid.map((row, y) =>
    row.map((p) => {
      const d = scanRow - y;
      if (d === 0) return p ? mix(p, palette.magenta, 0.65) : mix(palette.ground, palette.magenta, 0.35);
      if (d === 1 || d === 2) return p ? mix(p, palette.magenta, 0.3 / d) : p;
      return p;
    }),
  );
}

export interface BootFrame {
  /** The picture in its field of glyphs, as the screen draws it. */
  cells: EngramCell[][];
  wire: string;
  tagline: string;
  stats?: string;
  done: boolean;
}

const ease = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

/** Lines under the picture: a gap, the wire, the tagline, a gap, the stats, the version. */
const BELOW = 6;

/** Write `text` centred on row `y`, with a cell of clear ground either side so it reads over the field. */
function stamp(cells: EngramCell[][], y: number, text: string, fg: string): void {
  const row = cells[y];
  if (!row || !text) return;
  const chars = [...text];
  const x0 = Math.max(0, Math.floor((row.length - chars.length) / 2));
  for (let x = Math.max(0, x0 - 1); x < Math.min(row.length, x0 + chars.length + 1); x++) {
    const ch = chars[x - x0];
    row[x] = ch === undefined ? { ch: " " } : { ch, fg };
  }
}

/** The frame at `ms` since launch. */
export function bootFrame(ms: number, info: BootInfo, animate = true): BootFrame {
  const t = ms / BOOT_MS;
  const scanning = t >= 0.34 && t < 0.5;
  const scanRow = scanning ? Math.floor(((t - 0.34) / 0.16) * 20) : undefined;
  const blinking = t > 0.86 && t < 0.92;
  const art = scene(blinking, scanRow);
  // The whole terminal is the field; the picture and its lines sit in the middle of it.
  const cols = info.columns;
  const rows = Math.max(8, info.rows - 1);
  const pictureRows = Math.ceil(art.length / 2);
  const top = Math.max(0, Math.floor((rows - pictureRows - BELOW) / 2));
  const cells = engramFrame({ cols, rows, t: ms / 1000, art, variant: "boot", seed: 5, animate, fill: true, top });
  const wireT = ease((t - 0.5) / 0.25);
  const nodes = 5;
  const wireFull = Array.from({ length: nodes }, () => "◆").join("───");
  const wire = wireFull.slice(0, Math.round(wireFull.length * wireT));
  const tagline = TAGLINE.slice(0, Math.round(TAGLINE.length * ease((t - 0.55) / 0.3)));
  let stats: string | undefined;
  if (info.stats && t >= 0.8) {
    const k = ease((t - 0.8) / 0.18);
    const n = (x: number) => Math.round(x * k);
    stats = `◈ ${n(info.stats.memories)} memories   ◇ ${n(info.stats.skills)} skills   ▣ ${n(info.stats.sessions)} sessions`;
  }
  const under = top + pictureRows;
  stamp(cells, under + 1, wire, palette.cyan);
  stamp(cells, under + 2, tagline + (t >= 1 || tagline.length === TAGLINE.length ? "" : "▌"), palette.text);
  if (stats) stamp(cells, under + 4, stats, palette.amber);
  stamp(cells, under + 5, `v${info.version}`, palette.faint);
  return { cells, wire, tagline, stats, done: t >= 1 };
}

export function Boot({ info, onDone, at }: { info: BootInfo; onDone: () => void; at?: number }): React.ReactElement {
  const motion = useContext(MotionContext);
  const start = useRef(Date.now());
  const [ms, setMs] = useState(at ?? (motion ? 0 : BOOT_MS));
  const finished = useRef(false);
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    onDone();
  };
  useInput(() => finish(), { isActive: at === undefined });
  useEffect(() => {
    if (at !== undefined) return;
    if (!motion) {
      finish();
      return;
    }
    const id = setInterval(() => {
      const now = Date.now() - start.current;
      setMs(now);
      if (now >= BOOT_MS + 350) {
        clearInterval(id);
        finish();
      }
    }, 1000 / 30);
    return () => clearInterval(id);
  }, []);

  const f = bootFrame(ms, info, motion);
  const small = info.columns < 50 || info.rows < 18;
  if (!small) return <EngramCells cells={f.cells} />;
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" width={info.columns} height={Math.max(8, info.rows - 1)}>
      <Text color={palette.magenta} bold>
        ▞ MNEMO ▚
      </Text>
      <Box marginTop={1}>
        <Text color={palette.cyan}>{f.wire.padEnd(21)}</Text>
      </Box>
      <Text color={palette.text}>{f.tagline}</Text>
      <Box marginTop={1}>
        <Text color={palette.amber}>{f.stats ?? " "}</Text>
      </Box>
      <Text color={palette.faint}>v{info.version}</Text>
    </Box>
  );
}
