/**
 * The thinking animation: an ordered-dither field drifting in violet, brighter
 * cells leaning magenta (see `ditherFrame` in ../pixel.ts). One row beside the
 * working verb, two under a thought that is still streaming. Without motion it
 * is a still frame.
 */
import React, { useContext } from "react";
import { Box, Text, useAnimation } from "ink";
import { ditherFrame } from "../pixel.ts";
import { mix, palette } from "../theme.ts";
import { MotionContext } from "./motion.ts";

export function Dither({ width, rows = 1, seed = 3 }: { width: number; rows?: number; seed?: number }): React.ReactElement {
  const motion = useContext(MotionContext);
  const { frame } = useAnimation({ interval: 90, isActive: motion });
  const f = ditherFrame(width, rows, motion ? frame : 12, seed);
  const tone = (level: number) => mix(palette.rule, level > 0.8 ? palette.magenta : palette.violet, 0.35 + level * 0.65);
  const line = (row: (typeof f)[number], y: number) => (
    <Text key={y}>
      {row.map((c, i) => (
        <Text key={i} color={tone(c.level)}>
          {c.ch}
        </Text>
      ))}
    </Text>
  );
  return rows === 1 ? line(f[0]!, 0) : <Box flexDirection="column">{f.map(line)}</Box>;
}
