/** A grid of pixels, drawn two to a cell, in the current theme. */
import React from "react";
import { Box, Text } from "ink";
import { toCells, toRuns, type Grid } from "../pixel.ts";
import { themed } from "../theme.ts";

/** `inline`: a one-row sprite drawn as text, to sit inside a line. */
export function PixelArt({ grid, inline = false }: { grid: Grid; inline?: boolean }): React.ReactElement {
  const rows = toRuns(toCells(grid));
  if (inline)
    return (
      <Text>
        {(rows[0] ?? []).map((r, i) => (
          <Text key={i} color={r.fg && themed(r.fg)} backgroundColor={r.bg && themed(r.bg)}>
            {r.text}
          </Text>
        ))}
      </Text>
    );
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
