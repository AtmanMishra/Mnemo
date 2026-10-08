/**
 * Best-of-n as a race, one lane per candidate:
 *
 *   ▞▚ BEST OF 3 · judge: npm test
 *   1 ▄▀ ▸▸▸▸▸▸▸▸▸▸▸▸▸▸▷              running 0:42
 *   2 ▄▄ ████████████████████████ ✓ passed · 4 lines   ← the winner keeps its colour
 *   3 ▄▄ ▓▓▒▒░░░░                 ✗ check failed       ← the others dither out
 *
 * A running lane's track grows with time (it does not know how far along a
 * candidate is, only that it is still going); a finished one is full.
 */
import React from "react";
import { Box, Text, useAnimation } from "ink";
import type { Race } from "../../runtime/controller.ts";
import { formatDuration } from "../format.ts";
import { mix, palette } from "../theme.ts";
import { MotionContext } from "./motion.ts";

const LANE_COLORS = () => [palette.magenta, palette.cyan, palette.violet, palette.amber, palette.green];

/** A lane's track, `width` cells, at a moment. Pure, for tests. */
export function laneTrack(state: Race["lanes"][number]["state"], elapsedMs: number, width: number, frame: number, winner: boolean): string {
  if (state === "running" || state === "checking") {
    // Grows toward ~90% over two minutes, never quite arriving.
    const n = Math.max(1, Math.min(width - 2, Math.round((width - 2) * (1 - Math.exp(-elapsedMs / 60_000)))));
    const head = state === "checking" ? "◆" : frame % 2 ? "▷" : "▶";
    return `${"▸".repeat(n)}${head}`.padEnd(width);
  }
  if (state === "passed" || state === "done") return "█".repeat(width);
  if (winner) return "█".repeat(width);
  // Failed or errored: the track dissolves from the right.
  const ramp = ["▓", "▒", "░"];
  return Array.from({ length: width }, (_, i) => (i < width * 0.15 ? ramp[0] : i < width * 0.35 ? ramp[1] : ramp[2])).join("");
}

export function RaceView({ race, width, now = Date.now }: { race: Race; width: number; now?: () => number }): React.ReactElement {
  const motion = React.useContext(MotionContext);
  const { frame } = useAnimation({ interval: 250, isActive: motion && !race.done });
  const track = Math.max(10, Math.min(40, width - 36));
  const colors = LANE_COLORS();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={palette.magenta}>▞</Text>
        <Text color={palette.cyan}>▚ </Text>
        <Text bold color={palette.text}>{`BEST OF ${race.n}`}</Text>
        <Text color={palette.dim}>{` · judge: ${race.check}`}</Text>
        {race.done ? <Text color={race.winner ? palette.green : palette.red}>{race.winner ? `  ✓ candidate ${race.winner} applied` : "  ✗ none passed"}</Text> : null}
      </Text>
      {race.lanes.map((l, i) => {
        const won = race.winner === i + 1;
        const out = race.done && !won;
        const tint = out ? palette.faint : colors[i % colors.length]!;
        const elapsed = (l.endedAt ?? now()) - l.startedAt;
        const status =
          l.state === "running"
            ? `running ${formatDuration(elapsed)}`
            : l.state === "checking"
              ? "checking…"
              : l.state === "done"
                ? "waiting for the judge"
                : l.state === "passed"
                  ? `✓ passed · ${l.size ?? 0} lines${won ? " · winner" : ""}`
                  : l.state === "failed"
                    ? "✗ check failed"
                    : "✗ did not finish";
        const beat = !race.done && motion && l.state === "running" ? (frame % 2 === i % 2 ? "▄▀" : "▀▄") : "▄▄";
        return (
          <Text key={i}>
            <Text color={palette.dim}>{`${i + 1} `}</Text>
            <Text color={tint}>{`${beat} `}</Text>
            <Text color={won ? palette.green : out ? mix(palette.faint, palette.ground, 0.3) : tint}>{laneTrack(l.state, elapsed, track, frame, won)}</Text>
            <Text color={l.state === "passed" ? palette.green : l.state === "failed" || l.state === "error" ? palette.red : palette.dim}>{` ${status}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
