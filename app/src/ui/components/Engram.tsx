/**
 * Engram on screen (see ../engram.ts): animated at 12 frames a second while
 * motion is on; settled and still without it, in a dump, a test or a pipe.
 */
import React, { useContext, useRef } from "react";
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

/** A frame of cells, drawn as merged runs in the current theme. */
export function EngramCells({ cells }: { cells: EngramCell[][] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {cells.map((row, y) => (
        <Text key={y}>
          {runs(row).map((r, i) => (
            <Text key={i} color={r.fg && themed(r.fg)} backgroundColor={r.bg && themed(r.bg)}>
              {r.ch}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
