/**
 * The launch sequence, every time Mnemo opens (about 1.6 s; any key skips):
 *
 *   recall   Mne and the wordmark condense out of dither noise, pixel by
 *            pixel — a memory coming back
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
import { mne, pixelText, place, resolve, type Grid } from "../pixel.ts";
import { PixelArt } from "./PixelArt.tsx";
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
  grid: Grid;
  wire: string;
  tagline: string;
  stats?: string;
  done: boolean;
}

const ease = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

/** The frame at `ms` since launch. */
export function bootFrame(ms: number, info: BootInfo): BootFrame {
  const t = ms / BOOT_MS;
  const recall = Math.min(1, t / 0.34);
  const scanning = t >= 0.34 && t < 0.5;
  const scanRow = scanning ? Math.floor(((t - 0.34) / 0.16) * 20) : undefined;
  const blinking = t > 0.86 && t < 0.92;
  let grid = scene(blinking, scanRow);
  if (recall < 1) grid = resolve(grid, ease(recall));
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
  return { grid, wire, tagline, stats, done: t >= 1 };
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

  const f = bootFrame(ms, info);
  const small = info.columns < 50 || info.rows < 16;
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" width={info.columns} height={Math.max(8, info.rows - 1)}>
      {small ? (
        <Text color={palette.magenta} bold>
          ▞ MNEMO ▚
        </Text>
      ) : (
        <PixelArt grid={f.grid} />
      )}
      <Box marginTop={1}>
        <Text color={palette.cyan}>{f.wire.padEnd(21)}</Text>
      </Box>
      <Text color={palette.text}>
        {f.tagline}
        <Text color={palette.magenta}>{f.done || f.tagline.length === TAGLINE.length ? "" : "▌"}</Text>
      </Text>
      <Box marginTop={1}>
        <Text color={palette.amber}>{f.stats ?? " "}</Text>
      </Box>
      <Text color={palette.faint}>v{info.version}</Text>
    </Box>
  );
}
