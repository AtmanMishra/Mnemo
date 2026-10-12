/**
 * What replaced the spinner: a short strip of pixels that says what kind of
 * work is going on.
 *
 *   tool    a scanner: one lit pixel sweeps back and forth, trailing a fade
 *           (cyan → magenta), like a head reading a tape
 *   think   an ordered-dither field drifting in violet: a picture the
 *           model has not finished resolving (see ditherFrame)
 *   write   the answer is streaming: cells fill left to right through the
 *           eighth-blocks, in magenta, like a line being typed
 *   wait    one amber pixel breathing: the agent waits for you
 *
 * Without motion (tests, --no-motion, a pipe) it is a still row of dim pixels.
 */
import React from "react";
import { Text, useAnimation } from "ink";
import { ditherFrame } from "../pixel.ts";
import { mix, palette } from "../theme.ts";
import { MotionContext } from "./motion.ts";

export type PulseMode = "tool" | "think" | "write" | "wait";

/** The colours of each cell at a frame: pure, for tests. */
export function pulseFrame(mode: PulseMode, width: number, frame: number): { ch: string; color: string }[] {
  const cells: { ch: string; color: string }[] = [];
  if (mode === "tool") {
    const span = Math.max(1, width - 1);
    const t = frame % (span * 2);
    const head = t <= span ? t : span * 2 - t;
    for (let i = 0; i < width; i++) {
      const d = Math.abs(i - head);
      const lit = Math.max(0, 1 - d / 3);
      const hue = mix(palette.cyan, palette.magenta, i / Math.max(1, width - 1));
      cells.push({ ch: d === 0 ? "█" : d === 1 ? "▓" : d === 2 ? "▒" : "░", color: mix(palette.rule, hue, 0.25 + lit * 0.75) });
    }
  } else if (mode === "think") {
    for (const c of ditherFrame(width, 1, frame, 11)[0]!)
      cells.push({ ch: c.ch === " " ? "·" : c.ch, color: mix(palette.rule, c.level > 0.8 ? palette.magenta : palette.violet, 0.35 + c.level * 0.65) });
  } else if (mode === "write") {
    const eighths = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
    const span = width * 8 + 6;
    const fill = frame % span;
    for (let i = 0; i < width; i++) {
      const k = Math.max(0, Math.min(8, fill - i * 8));
      const fade = fill > width * 8 ? 1 - (fill - width * 8) / 6 : 1;
      cells.push({ ch: eighths[k]!, color: mix(palette.rule, palette.magenta, (0.4 + 0.6 * (k / 8)) * fade) });
    }
  } else {
    const breathe = (Math.sin(frame / 3) + 1) / 2;
    for (let i = 0; i < width; i++) cells.push({ ch: i === 0 ? "■" : " ", color: mix(palette.rule, palette.amber, 0.4 + breathe * 0.6) });
  }
  return cells;
}

export function Pulse({ mode = "think", width = 6 }: { mode?: PulseMode; width?: number }): React.ReactElement {
  const motion = React.useContext(MotionContext);
  const { frame } = useAnimation({ interval: 90, isActive: motion });
  if (!motion) return <Text color={palette.faint}>{"▪".repeat(Math.min(3, width)).padEnd(width)}</Text>;
  return (
    <Text>
      {pulseFrame(mode, width, frame).map((c, i) => (
        <Text key={i} color={c.color}>
          {c.ch}
        </Text>
      ))}
    </Text>
  );
}
