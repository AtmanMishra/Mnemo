/**
 * A sub-agent in a split pane: what it was asked, what it is doing, what it
 * answered, and the agents under it. Focused (alt+, alt+.), it has a one-line
 * prompt: what you type reaches the running sub-agent after its current step, as
 * your words. Its parent still drives it and gets its answer.
 */
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { isEnded, type RosterNode } from "../runtime/roster.ts";
import { statusStyle, treeOf } from "./tree.ts";
import { palette } from "./theme.ts";
import { useSettings } from "./settings-context.ts";

const clip = (s: string, n: number) => (n <= 0 ? "" : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

export type TellResult = { ok: true } | { ok: false; reason: string };

export function NodePane({
  node,
  nodes,
  width,
  height,
  focused,
  onTell,
}: {
  node: RosterNode;
  nodes: readonly RosterNode[];
  width: number;
  height: number;
  focused: boolean;
  /** Send what you typed to the sub-agent. */
  onTell?: (text: string) => TellResult;
}): React.ReactElement {
  const prefs = useSettings();
  const [draft, setDraft] = useState("");
  const [said, setSaid] = useState<{ text: string; ok: boolean } | undefined>();
  const open = node.status === "running" && !!onTell;
  useInput(
    (input, key) => {
      if (key.return) {
        if (!draft.trim()) return;
        const r = onTell!(draft);
        setSaid(r.ok ? { text: "sent: it reads it after its current step", ok: true } : { text: r.reason, ok: false });
        if (r.ok) setDraft("");
        return;
      }
      if (key.backspace || key.delete) return setDraft((d) => d.slice(0, -1));
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (input) setDraft((d) => d + input.replace(/[\r\n]+/g, " "));
    },
    { isActive: focused && open },
  );
  const st = statusStyle(node.status);
  const lines: { text: string; tone: string }[] = [];
  const wrap = (label: string, text: string, tone: string, max: number) => {
    const words = `${label}${text.replace(/\s+/g, " ")}`;
    for (let i = 0, n = 0; i < words.length && n < max; i += width - 2, n++) lines.push({ text: words.slice(i, i + width - 2), tone });
  };
  wrap("task: ", node.task, palette.dim, 4);
  lines.push({ text: node.stepCount ? `steps (${node.stepCount})` : "no steps yet", tone: palette.faint });
  for (const s of node.steps.slice(-6)) lines.push({ text: `  ${s}`, tone: palette.dim });
  if (node.answer) wrap("answer: ", node.answer, palette.text, 6);
  const kids = treeOf(nodes, node.id).slice(1);
  if (kids.length) {
    lines.push({ text: "under it", tone: palette.faint });
    for (const k of kids.slice(0, 6)) lines.push({ text: `${k.prefix.slice(0)}${statusStyle(k.node.status).glyph} ${k.node.label}`, tone: palette.dim });
  }
  const prompt = focused ? (open ? 2 : 1) : open && height >= 8 ? 1 : 0;
  const room = Math.max(0, height - 1 - prompt);
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={st.tone}>{st.glyph} </Text>
        <Text bold color={focused ? palette.text : palette.dim}>
          {clip(node.label, Math.max(4, width - 24))}
        </Text>
        <Text color={palette.faint}>{`  sub-agent · depth ${node.depth} · ${node.access} · ${node.status}`}</Text>
      </Text>
      {lines.slice(0, room).map((l, i) => (
        <Text key={i} color={l.tone} wrap="truncate-end">
          {clip(l.text, width - 2)}
        </Text>
      ))}
      <Box flexGrow={1} />
      {!focused && open && height >= 8 ? (
        <Text color={palette.faint} wrap="truncate-end">
          {clip(`${prefs["keys.prevAgent"]} ${prefs["keys.nextAgent"]} to focus it and type to it`, width - 2)}
        </Text>
      ) : null}
      {focused && open ? (
        <Text color={said ? (said.ok ? palette.faint : palette.magenta) : palette.faint} wrap="truncate-end">
          {clip(said?.text ?? "type to tell it something · enter sends", width - 2)}
        </Text>
      ) : null}
      {focused ? (
        open ? (
          <Text wrap="truncate-end">
            <Text color={palette.magenta}>{"❯ "}</Text>
            <Text color={palette.text}>{clip(draft.length > width - 6 ? `…${draft.slice(-(width - 7))}` : draft, width - 4)}</Text>
            <Text color={palette.magenta}>▏</Text>
          </Text>
        ) : (
          <Text color={palette.faint} wrap="truncate-end">
            {clip(isEnded(node.status) ? "it has finished: nothing more reaches it" : "it is not running: nothing reaches it now", width - 2)}
          </Text>
        )
      ) : null}
    </Box>
  );
}
