/**
 * The line that says the agent is busy: spinner, a shimmering verb, how long,
 * how much it has written, and how to stop it. Then whatever is queued.
 */
import React from "react";
import { Box, Text, useAnimation } from "ink";
import type { Working as WorkingState } from "../store.ts";
import { color, glyph, mix, workingVerbs } from "../theme.ts";
import { formatDuration, formatTokens } from "../format.ts";
import { MotionContext } from "./motion.ts";
import { Spinner } from "./Spinner.tsx";

function Shimmer({ text, frame, motion }: { text: string; frame: number; motion: boolean }): React.ReactElement {
  if (!motion) return <Text color={color.accent}>{text}</Text>;
  const chars = [...text];
  const pos = (frame % (chars.length + 8)) - 4;
  return (
    <Text>
      {chars.map((ch, i) => {
        const glow = Math.max(0, 1 - Math.abs(i - pos) / 3);
        return (
          <Text key={i} color={mix(color.accent, "#FFFFFF", glow * 0.75)}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
}

export function WorkingLine({
  working,
  message,
  queue,
  now = Date.now,
}: {
  working: WorkingState | null;
  message?: string;
  queue: readonly string[];
  now?: () => number;
}): React.ReactElement | null {
  const motion = React.useContext(MotionContext);
  const { frame } = useAnimation({ interval: 120, isActive: motion && working !== null });
  if (!working && queue.length === 0) return null;
  const elapsed = working ? now() - working.since : 0;
  const verb = message ?? `${workingVerbs[Math.floor(elapsed / 4000 + working!.since / 7) % workingVerbs.length]}…`;
  return (
    <Box flexDirection="column" marginTop={1}>
      {working ? (
        <Box flexDirection="row">
          <Box width={2}>
            <Spinner />
          </Box>
          <Shimmer text={verb} frame={frame} motion={motion} />
          <Text color={color.muted}>
            {" "}
            ({formatDuration(elapsed)}
            {working.tokens > 0 ? ` · ↓ ${formatTokens(working.tokens)} tokens` : ""} ·{" "}
            <Text color={color.accent}>esc</Text> to interrupt)
          </Text>
        </Box>
      ) : null}
      {queue.map((q, i) => (
        <Box key={i} paddingLeft={2}>
          <Text color={color.warning} wrap="truncate-end">
            {glyph.queued} queued: <Text color={color.muted}>{q.replace(/\s+/g, " ")}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}
