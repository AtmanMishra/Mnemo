/**
 * The playground: every agent and what passes between them, to watch.
 *
 *   ↑↓ select · enter open that agent in the agents page · m messages only · ^y back
 *
 * It is read-only by construction. It is given a `RosterView` (a snapshot and a
 * subscription, nothing that changes the roster), has no prompt, and cannot stop,
 * steer or message an agent. The one thing it can do is take you to the agent,
 * where you can talk to it.
 */
import React, { useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import type { RosterEvent, RosterNode, RosterSnapshot, RosterView } from "../runtime/roster.ts";
import { linkedRoots, statusStyle, treeOf } from "./tree.ts";
import { palette } from "./theme.ts";

export interface PlaygroundProps {
  roster: RosterView;
  width: number;
  height: number;
  active: boolean;
  /** Go to the agent that owns this node (the only action the playground has). */
  onOpen: (rootNode: number) => void;
}

const clip = (s: string, n: number) => (n <= 0 ? "" : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
const clock = (t: number) => new Date(t).toTimeString().slice(0, 8);

/** One feed entry in words; `labels` names every node, including the ones that left. */
export function feedLine(e: RosterEvent, labels: ReadonlyMap<number, string>): { text: string; tone: string } {
  const name = (id: number | undefined) => (id === undefined ? "?" : (labels.get(id) ?? `#${id}`));
  switch (e.kind) {
    case "root":
      return { text: `◇ ${name(e.node)} opened`, tone: palette.dim };
    case "close":
      return { text: `◇ ${name(e.node)} closed`, tone: palette.dim };
    case "spawn":
      return { text: `⑂ ${name(e.parent)} started ${name(e.node)}`, tone: palette.cyan };
    case "done":
      return { text: `✓ ${name(e.node)} finished`, tone: palette.green };
    case "failed":
      return { text: `✗ ${name(e.node)} failed`, tone: palette.red };
    case "stopped":
      return { text: `■ ${name(e.node)} stopped`, tone: palette.amber };
    case "message":
      return { text: `✉ ${name(e.from)} → ${name(e.to)}: ${e.text.replace(/\s+/g, " ")}`, tone: palette.text };
    case "link":
      return { text: `⇄ ${name(e.node)} linked with ${name(e.other)}`, tone: palette.magenta };
    case "unlink":
      return { text: `⇄ ${name(e.node)} left its siblings`, tone: palette.dim };
  }
}

interface Row {
  node: RosterNode;
  prefix: string;
}

/** Every root with its tree, in order. */
export function playgroundRows(snap: Pick<RosterSnapshot, "nodes">): Row[] {
  return snap.nodes.filter((n) => n.kind === "root").flatMap((r) => treeOf(snap.nodes, r.id));
}

function rootOf(snap: Pick<RosterSnapshot, "nodes">, n: RosterNode): RosterNode {
  let at = n;
  while (at.parent !== undefined) {
    const p = snap.nodes.find((x) => x.id === at.parent);
    if (!p) break;
    at = p;
  }
  return at;
}

export function Playground(p: PlaygroundProps): React.ReactElement {
  const snap = useSyncExternalStore(p.roster.subscribe, p.roster.snapshot);
  const [sel, setSel] = useState(0);
  const [onlyMessages, setOnlyMessages] = useState(false);
  const rows = playgroundRows(snap);
  const at = Math.min(sel, Math.max(0, rows.length - 1));
  const chosen = rows[at]?.node;

  useInput(
    (input, key) => {
      if (key.upArrow) return setSel(Math.max(0, at - 1));
      if (key.downArrow) return setSel(Math.min(rows.length - 1, at + 1));
      if (input === "m") return setOnlyMessages((v) => !v);
      if (key.return && chosen) return p.onOpen(rootOf(snap, chosen).id);
    },
    { isActive: p.active },
  );

  const wide = p.width >= 100;
  const bodyH = Math.max(4, p.height - 3);
  const treeW = wide ? Math.floor((p.width - 4) * 0.46) : p.width - 4;
  const feedW = wide ? p.width - 4 - treeW - 2 : p.width - 4;
  const treeH = wide ? bodyH : Math.ceil(bodyH / 2);
  const feedH = wide ? bodyH : bodyH - treeH;
  const detailH = Math.min(5, Math.max(0, treeH - 4));
  const listH = Math.max(1, treeH - detailH - 1);
  const first = Math.max(0, Math.min(at - listH + 1, rows.length - listH));
  const shown = rows.slice(first, first + listH);

  const events = snap.events.filter((e) => !onlyMessages || e.kind === "message");
  const feed = events.slice(-Math.max(1, feedH - 1));
  const running = snap.nodes.filter((n) => n.status === "running").length;
  const roots = snap.nodes.filter((n) => n.kind === "root").length;

  const detail: string[] = [];
  if (chosen) {
    const links = chosen.kind === "root" ? linkedRoots(snap, chosen.id).map((n) => n.label) : [];
    detail.push(`${chosen.label} · ${chosen.kind === "root" ? "top-level" : `sub-agent, depth ${chosen.depth}`} · ${chosen.status}${chosen.kind === "sub" ? ` · ${chosen.access}` : ""}${links.length ? ` · ⇄ ${links.join(", ")}` : ""}`);
    if (chosen.task) detail.push(`${chosen.kind === "root" ? "last prompt" : "task"}: ${chosen.task.replace(/\s+/g, " ")}`);
    for (const s of chosen.steps.slice(-2)) detail.push(`  ${s}`);
    if (chosen.answer) detail.push(`answer: ${chosen.answer.replace(/\s+/g, " ")}`);
  }

  return (
    <Box flexDirection="column" width={p.width} height={p.height} paddingX={2}>
      <Text wrap="truncate-end">
        <Text bold color={palette.magenta}>
          PLAYGROUND{" "}
        </Text>
        <Text color={palette.text}>{`${roots} agent${roots === 1 ? "" : "s"}`}</Text>
        <Text color={palette.magenta}>{running ? `  ● ${running} working` : ""}</Text>
        <Text color={palette.faint}>{"   supervise only · you cannot steer from here"}</Text>
      </Text>
      <Box flexDirection={wide ? "row" : "column"} marginTop={1} height={bodyH}>
        <Box flexDirection="column" width={treeW} height={treeH}>
          {shown.map(({ node, prefix }, i) => {
            const on = first + i === at;
            const st = statusStyle(node.status);
            const links = node.kind === "root" ? linkedRoots(snap, node.id).length : 0;
            return (
              <Text key={node.id} backgroundColor={on ? palette.selectBg : undefined} wrap="truncate-end">
                <Text color={palette.faint}>{prefix}</Text>
                <Text color={st.tone}>{st.glyph} </Text>
                <Text color={on ? palette.text : node.kind === "root" ? palette.text : palette.dim} bold={node.kind === "root"}>
                  {clip(node.label, 24)}
                </Text>
                <Text color={palette.magenta}>{links ? ` ⇄${links}` : ""}</Text>
                <Text color={palette.faint}>{node.kind === "sub" && node.task ? `  ${clip(node.task.replace(/\s+/g, " "), Math.max(0, treeW - prefix.length - node.label.length - 8))}` : ""}</Text>
              </Text>
            );
          })}
          {rows.length === 0 ? <Text color={palette.faint}>no agents</Text> : null}
          <Box flexGrow={1} />
          {detailH > 0 ? (
            <Box flexDirection="column" height={detailH} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor={palette.rule}>
              {detail.slice(0, detailH - 1).map((l, i) => (
                <Text key={i} color={i === 0 ? palette.text : palette.dim} wrap="truncate-end">
                  {clip(l, treeW)}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
        {wide ? <Box width={2} /> : null}
        <Box flexDirection="column" width={feedW} height={feedH}>
          <Text color={palette.faint}>{onlyMessages ? "MESSAGES" : "ACTIVITY"}</Text>
          {feed.length === 0 ? <Text color={palette.faint}>nothing has happened yet</Text> : null}
          {feed.map((e, i) => {
            const l = feedLine(e, snap.labels);
            return (
              <Text key={`${e.at}-${i}`} wrap="truncate-end">
                <Text color={palette.faint}>{`${clock(e.at)} `}</Text>
                <Text color={l.tone}>{clip(l.text, Math.max(0, feedW - 9))}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>
      <Box flexGrow={1} />
      <Text color={palette.faint} wrap="truncate-end">
        {p.width >= 80 ? `↑↓ select · enter open in the agents page · m ${onlyMessages ? "all activity" : "messages only"} · ^y back` : "↑↓ · enter open · m · ^y back"}
      </Text>
    </Box>
  );
}
