/** A grid of pixels, drawn two to a cell. */
import React from "react";
import { Box, Text } from "ink";
import { toCells, toRuns, type Grid } from "../pixel.ts";

export function PixelArt({ grid }: { grid: Grid }): React.ReactElement {
  const rows = toRuns(toCells(grid));
  return (
    <Box flexDirection="column">
      {rows.map((row, y) => (
        <Text key={y}>
          {row.length === 0
            ? " "
            : row.map((r, i) => (
                <Text key={i} color={r.fg} backgroundColor={r.bg}>
                  {r.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
