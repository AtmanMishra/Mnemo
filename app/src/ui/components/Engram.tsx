/**
 * Engram on screen (see ../engram.ts): animated at 12 frames a second while
 * motion is on; settled and still without it, in a dump, a test or a pipe.
 */
import React, { useContext, useRef } from "react";
import chalk from "chalk";
import { Box, Text, useAnimation } from "ink";
import { engramFrame, type EngramCell, type EngramVariant } from "../engram.ts";
import type { Grid } from "../pixel.ts";
import { themed } from "../theme.ts";
import { MotionContext } from "./motion.ts";

const FRAME_MS = 80;

function runs(row: EngramCell[]): EngramCell[] {
  const out: EngramCell[] = [];
  for (const c of row) {
    const last = out.at(-1);
    if (last && last.fg === c.fg && last.bg === c.bg) last.ch += c.ch;
    else out.push({ ...c });
  }
  return out;
}

/** `since`: when its clock started (default: when it mounted). A block printed into scrollback later keeps its age. */
export function Engram({ cols, rows, seed = 7, variant, art, since }: { cols: number; rows: number; seed?: number; variant?: EngramVariant; art?: Grid; since?: number }): React.ReactElement {
  const motion = useContext(MotionContext);
  const start = useRef(since ?? Date.now());
  // The frame counter drives re-renders; the picture is a function of real time.
  useAnimation({ interval: FRAME_MS, isActive: motion });
  return <EngramCells cells={engramFrame({ cols, rows, t: (Date.now() - start.current) / 1000, seed, animate: motion, variant, art })} />;
}

/**
 * A frame of cells, drawn as merged runs in the current theme. Each row is one
 * pre-coloured string, not a Text per run: a whole-terminal field is thousands
 * of runs, and React would otherwise rebuild them all twelve times a second.
 */
export function EngramCells({ cells }: { cells: EngramCell[][] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {cells.map((row, y) => (
        <Text key={y}>{rowString(row)}</Text>
      ))}
    </Box>
  );
}

export function rowString(row: EngramCell[]): string {
  return runs(row)
    .map((r) => {
      let paint = chalk;
      if (r.fg) paint = paint.hex(themed(r.fg));
      if (r.bg) paint = paint.bgHex(themed(r.bg));
      return r.fg || r.bg ? paint(r.ch) : r.ch;
    })
    .join("");
}

/**
 * The whole terminal as a living field, behind a screen of text: put it first
 * in a box of the same size and the text, on a box with a background, over it.
 */
export function Backdrop({ cols, rows, seed = 11, art }: { cols: number; rows: number; seed?: number; art?: Grid }): React.ReactElement {
  const motion = useContext(MotionContext);
  const start = useRef(Date.now());
  useAnimation({ interval: FRAME_MS, isActive: motion });
  const cells = engramFrame({ cols, rows, t: (Date.now() - start.current) / 1000, seed, animate: motion, variant: "ambient", art: art ?? [], fill: true });
  return (
    <Box position="absolute" flexDirection="column" width={cols} height={rows} overflow="hidden">
      <EngramCells cells={cells} />
    </Box>
  );
}
