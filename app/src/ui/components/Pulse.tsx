/**
 * What replaced the spinner: a short strip of pixels that says what kind of
 * work is going on.
 *
 *   tool    a scanner: one lit pixel sweeps back and forth, trailing a fade
 *           (cyan → magenta), like a head reading a tape
 *   think   neurons: pixels flicker at random brightness in violet, a field
 *           that settles the moment the answer starts
 *   wait    one amber pixel breathing: the agent waits for you
 *
 * Without motion (tests, --no-motion, a pipe) it is a still row of dim pixels.
 */
import React from "react";
import { Text, useAnimation } from "ink";
import { hash01 } from "../pixel.ts";
import { mix, palette } from "../theme.ts";
import { MotionContext } from "./motion.ts";

export type PulseMode = "tool" | "think" | "wait";

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
    const glyphs = [" ", "·", "∙", "•", "▪"];
    for (let i = 0; i < width; i++) {
      const v = hash01(i, Math.floor(frame / 1.5), 11);
      cells.push({ ch: glyphs[Math.min(glyphs.length - 1, Math.floor(v * glyphs.length))]!, color: mix(palette.rule, v > 0.8 ? palette.magenta : palette.violet, 0.35 + v * 0.65) });
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
