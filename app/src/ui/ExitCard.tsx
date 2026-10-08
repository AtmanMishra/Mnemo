/**
 * The last screen: Mne waving goodbye over what this run did. It shows for a
 * moment after the last agent closes; `exitLine` is the same in one line, for
 * the scrollback once the full screen is gone.
 */
import React from "react";
import { Box, Text, useAnimation } from "ink";
import type { FleetSummary } from "../runtime/fleet.ts";
import { MotionContext } from "./components/motion.ts";
import { PixelArt } from "./components/PixelArt.tsx";
import { mne, pixelText } from "./pixel.ts";
import { palette } from "./theme.ts";
import { formatDuration } from "./format.ts";

export function summaryParts(s: FleetSummary, now = Date.now()): string[] {
  return [
    `${s.agents} agent${s.agents === 1 ? "" : "s"}`,
    `${s.turns} turn${s.turns === 1 ? "" : "s"}`,
    `${s.files} file${s.files === 1 ? "" : "s"} changed`,
    `+${s.learned} learned`,
    ...(s.cost > 0 ? [`$${s.cost.toFixed(3)}`] : []),
    formatDuration(Math.max(0, now - s.startedAt)),
  ];
}

/** The one-line card for the terminal's scrollback, with colour. */
export function exitLine(s: FleetSummary, now = Date.now()): string {
  const rgb = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  };
  const dot = `${rgb(palette.faint)} · `;
  return `${rgb(palette.magenta)}▞${rgb(palette.cyan)}▚ ${rgb(palette.text)}mnemo${dot}${summaryParts(s, now).map((p) => `${rgb(p.startsWith("+") ? palette.amber : palette.dim)}${p}`).join(dot)}\x1b[0m`;
}

export function ExitCard({ summary, width, height }: { summary: FleetSummary; width: number; height: number }): React.ReactElement {
  const motion = React.useContext(MotionContext);
  const { frame } = useAnimation({ interval: 220, isActive: motion });
  // Waving: an ear up, then down.
  const pose = motion && frame % 2 === 1 ? mne.blink : mne.idle;
  return (
    <Box width={width} height={height} flexDirection="column" alignItems="center" justifyContent="center">
      <Box>
        <PixelArt grid={pose} />
        <Box flexDirection="column" marginLeft={3} justifyContent="center">
          <PixelArt grid={pixelText("SEE YOU", { shadow: palette.rule })} />
          <Text> </Text>
          <Text>
            {summaryParts(summary).map((p, i) => (
              <Text key={i}>
                {i > 0 ? <Text color={palette.faint}> · </Text> : null}
                <Text color={p.startsWith("+") ? palette.amber : palette.text}>{p}</Text>
              </Text>
            ))}
          </Text>
          <Text color={palette.faint}>Mne remembers. Run mnemo again to pick up where you left off.</Text>
        </Box>
      </Box>
    </Box>
  );
}
