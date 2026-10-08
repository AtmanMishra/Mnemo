/**
 * Mne, showing what the agent is doing.
 *
 * In the header (one row): a two-pixel light in the mood's colour, and for a
 * few seconds after something happens, what it was:
 *   ✓ 12 passed (green) · ✗ 2 failed (red) · ✦ recalled 3 · ◈ +2 learned ·
 *   ◇ skill saved (amber) · ⚡ escalated (violet)
 *
 * Beside the working line (two rows): Mne at icon size, posed by mood —
 *   thinking  violet, eyes glancing left and right
 *   tool      cyan, eyes down at the work
 *   waiting   amber, looking at you
 */
import React, { useEffect, useState } from "react";
import { Text, useAnimation } from "ink";
import type { Activity } from "../../runtime/controller.ts";
import { mneMini } from "../pixel.ts";
import { palette } from "../theme.ts";
import { MotionContext } from "./motion.ts";
import { PixelArt } from "./PixelArt.tsx";

export type MneMood = "idle" | "thinking" | "tool" | "waiting";

const REACT_MS = 3500;

export const moodColor = (m: MneMood): string =>
  m === "thinking" ? palette.violet : m === "tool" ? palette.cyan : m === "waiting" ? palette.amber : palette.hide;

/** What an activity looks like in the header. */
export function reaction(a: Activity): { label: string; tone: string } {
  switch (a.kind) {
    case "check":
      return a.ok
        ? { label: `✓ ${a.tests ? `${a.tests.passed} passed` : "check passed"}`, tone: palette.green }
        : { label: `✗ ${a.tests ? `${a.tests.failed} failed` : "check failed"}`, tone: palette.red };
    case "recall":
      return { label: `✦ recalled ${a.count ?? ""}`.trim(), tone: palette.amber };
    case "learned":
      return { label: `◈ +${a.count ?? 1} learned`, tone: palette.amber };
    case "skill":
      return { label: "◇ skill saved", tone: palette.amber };
    case "escalated":
      return { label: "⚡ escalated", tone: palette.violet };
  }
}

/** True while an activity is recent enough to show; re-renders when it expires. */
export function useFresh(activity: Activity | undefined, now: () => number = Date.now): boolean {
  const [, tick] = useState(0);
  const fresh = !!activity && now() - activity.at < REACT_MS;
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => tick((n) => n + 1), REACT_MS + 50);
    return () => clearTimeout(t);
  }, [activity?.seq]);
  return fresh;
}

/** The header's light and reaction. */
export function MneBadge({ mood, activity }: { mood: MneMood; activity?: Activity }): React.ReactElement {
  const motion = React.useContext(MotionContext);
  const { frame } = useAnimation({ interval: 220, isActive: motion && mood !== "idle" });
  const fresh = useFresh(activity);
  const r = fresh && activity ? reaction(activity) : undefined;
  const tint = r?.tone ?? moodColor(mood);
  const beat = mood !== "idle" && motion ? (frame % 2 === 0 ? "▄▀" : "▀▄") : "▄▄";
  return (
    <Text>
      <Text color={tint}>{beat}</Text>
      {r ? <Text color={r.tone}>{` ${r.label}`}</Text> : null}
    </Text>
  );
}

/** Mne at icon size, two rows, posed by mood. */
export function MneFace({ mood }: { mood: MneMood }): React.ReactElement {
  const motion = React.useContext(MotionContext);
  const { frame } = useAnimation({ interval: 140, isActive: motion });
  const look = mood === "tool" ? "down" : mood === "thinking" && motion ? (["left", "ahead", "right", "ahead"] as const)[Math.floor(frame / 5) % 4]! : frame % 30 === 29 ? "blink" : "ahead";
  return <PixelArt grid={mneMini(moodColor(mood), look)} />;
}
