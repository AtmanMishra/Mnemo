/**
 * Toasts: what happens in agents you are not looking at, as chips at the top
 * right. Each slides in from the edge, holds, and dithers away:
 *
 *                                    ▐ app·2  ✓ 12 passed ▌
 *                                    ▐ api  ! waiting for you ▌
 */
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useAnimation } from "ink";
import type { Agent } from "../runtime/fleet.ts";
import { reaction } from "./components/MneBadge.tsx";
import { MotionContext } from "./components/motion.ts";
import { palette } from "./theme.ts";

export interface Toast {
  key: string;
  agent: string;
  label: string;
  tone: string;
  at: number;
}

const LIFE_MS = 4500;
const IN_MS = 300;
const OUT_MS = 450;
const MAX = 3;

/**
 * Collect toasts from every agent that is not on screen and focused: its
 * latest activity, and a dialog that started waiting for you.
 */
export function useToasts(agents: readonly Agent[], visible: (id: number) => boolean, version: number): Toast[] {
  const seen = useRef(new Map<string, true>());
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const fresh: Toast[] = [];
    for (const a of agents) {
      const act = a.controller.snapshot().activity;
      const dialog = a.controller.dialogs.current();
      const quiet = visible(a.id);
      if (act) {
        const key = `${a.id}:a:${act.seq}`;
        if (!seen.current.has(key)) {
          seen.current.set(key, true);
          if (!quiet) fresh.push({ key, agent: a.name, ...reaction(act), at: Date.now() });
        }
      }
      if (dialog) {
        const key = `${a.id}:d:${dialog.id}`;
        if (!seen.current.has(key)) {
          seen.current.set(key, true);
          if (!quiet) fresh.push({ key, agent: a.name, label: "! waiting for you", tone: palette.amber, at: Date.now() });
        }
      }
    }
    if (fresh.length) setToasts((t) => [...t, ...fresh].slice(-MAX));
  }, [version]);
  // Expire old ones.
  useEffect(() => {
    if (toasts.length === 0) return;
    const next = Math.min(...toasts.map((t) => t.at + LIFE_MS)) - Date.now();
    const timer = setTimeout(() => setToasts((t) => t.filter((x) => Date.now() - x.at < LIFE_MS)), Math.max(30, next));
    return () => clearTimeout(timer);
  }, [toasts]);
  return toasts;
}

/** A toast's text at an age: sliding in, held, or dithering out. Pure, for tests. */
export function toastFrame(text: string, age: number): { text: string; shift: number } {
  if (age < IN_MS) return { text, shift: Math.ceil((1 - age / IN_MS) * 8) };
  const left = LIFE_MS - age;
  if (left < OUT_MS) {
    const p = 1 - left / OUT_MS;
    const ramp = ["▓", "▒", "░", " "];
    // Characters give way to the ramp from the right edge inward.
    const cut = Math.floor(text.length * (1 - p));
    return { text: text.slice(0, cut) + ramp[Math.min(3, Math.floor(p * 4))]!.repeat(text.length - cut), shift: 0 };
  }
  return { text, shift: 0 };
}

export function Toasts({ toasts, columns }: { toasts: readonly Toast[]; columns: number }): React.ReactElement | null {
  const motion = React.useContext(MotionContext);
  const { frame } = useAnimation({ interval: 60, isActive: motion && toasts.length > 0 });
  void frame;
  if (toasts.length === 0) return null;
  const width = Math.min(46, columns - 4);
  return (
    <Box position="absolute" marginTop={1} marginLeft={Math.max(0, columns - width - 1)} width={width} flexDirection="column" alignItems="flex-end">
      {toasts.map((t) => {
        const body = ` ${t.agent}  ${t.label} `.slice(0, width - 2);
        const f = motion ? toastFrame(body, Date.now() - t.at) : { text: body, shift: 0 };
        return (
          <Box key={t.key} marginRight={f.shift}>
            <Text color={t.tone}>▐</Text>
            <Text backgroundColor={palette.panel} color={palette.text}>
              <Text bold color={t.tone}>
                {f.text.slice(0, t.agent.length + 1)}
              </Text>
              {f.text.slice(t.agent.length + 1)}
            </Text>
            <Text color={t.tone}>▌</Text>
          </Box>
        );
      })}
    </Box>
  );
}
