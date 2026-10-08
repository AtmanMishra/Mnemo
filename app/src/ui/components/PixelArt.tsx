/** A grid of pixels, drawn two to a cell, in the current theme. */
import React from "react";
import { Box, Text } from "ink";
import { toCells, toRuns, type Grid } from "../pixel.ts";
import { themed } from "../theme.ts";

export function PixelArt({ grid }: { grid: Grid }): React.ReactElement {
  const rows = toRuns(toCells(grid));
  return (
    <Box flexDirection="column">
      {rows.map((row, y) => (
        <Text key={y}>
          {row.length === 0
            ? " "
            : row.map((r, i) => (
                <Text key={i} color={r.fg && themed(r.fg)} backgroundColor={r.bg && themed(r.bg)}>
                  {r.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
