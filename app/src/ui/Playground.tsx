/**
 * The playground: every agent and what passes between them, to watch.
 *
 *   ↑↓ select · enter open that agent in the agents page · m messages only
 *   c the selected agent's conversation with another (tab: the next one) · ^y back
 *
 * It is read-only by construction. It is given a `RosterView` (a snapshot and a
 * subscription, nothing that changes the roster), has no prompt, and cannot stop,
 * steer or message an agent. The one thing it can do is take you to the agent,
 * where you can talk to it.
 */
import React, { useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { usage, type RosterEvent, type RosterNode, type RosterSnapshot, type RosterView } from "../runtime/roster.ts";
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
      return {
        text: `✉ ${name(e.from)} → ${name(e.to)}${e.delivery === "woken" ? " (woke it)" : e.delivery === "held" ? " (held for its user)" : ""}: ${e.text.replace(/\s+/g, " ")}`,
        tone: e.delivery === "held" ? palette.amber : palette.text,
      };
    case "link":
      return { text: `⇄ ${name(e.node)} linked with ${name(e.other)}`, tone: palette.magenta };
    case "unlink":
      return { text: `⇄ ${name(e.node)} left its siblings`, tone: palette.dim };
    case "told":
      return { text: `✎ you → ${name(e.node)}: ${e.text.replace(/\s+/g, " ")}`, tone: palette.cyan };
    case "capped":
      return { text: `$ ${name(e.node)} spent $${e.spent.toFixed(2)} on turns messages started: stopped, and woken by none until you prompt it`, tone: palette.amber };
    case "budget":
      return { text: `$ ${name(e.node)} reached its run budget at $${e.spent.toFixed(2)}: stopped`, tone: palette.amber };
  }
}

type Message = Extract<RosterEvent, { kind: "message" }>;

/** Who `id` has exchanged messages with, most messages first. */
export function partners(snap: Pick<RosterSnapshot, "events">, id: number): number[] {
  const count = new Map<number, number>();
  for (const e of snap.events)
    if (e.kind === "message" && (e.from === id || e.to === id)) {
      const other = e.from === id ? e.to : e.from;
      count.set(other, (count.get(other) ?? 0) + 1);
    }
  return [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([n]) => n);
}

/** The messages between two nodes as a thread: a heading per message, then its text wrapped to `width`. */
export function threadLines(snap: Pick<RosterSnapshot, "events" | "labels">, a: number, b: number, width: number): { text: string; tone: string }[] {
  const name = (id: number) => snap.labels.get(id) ?? `#${id}`;
  const out: { text: string; tone: string }[] = [];
  const w = Math.max(8, width - 2);
  for (const e of snap.events) {
    if (e.kind !== "message" || !((e.from === a && e.to === b) || (e.from === b && e.to === a))) continue;
    const m = e as Message;
    const how = m.delivery === "woken" ? " · woke it" : m.delivery === "held" ? " · held for its user" : "";
    out.push({ text: `${clock(m.at)} ${name(m.from)} → ${name(m.to)}${how}`, tone: m.from === a ? palette.cyan : palette.magenta });
    const words = m.text.replace(/\s+/g, " ").trim();
    const lines: string[] = [];
    for (let i = 0; i < words.length && lines.length < 6; i += w) lines.push(words.slice(i, i + w));
    if (lines.length === 6 && words.length > 6 * w) lines[5] = `${lines[5]!.slice(0, w - 1)}…`;
    for (const l of lines) out.push({ text: `  ${l}`, tone: m.delivery === "held" ? palette.amber : palette.text });
  }
  return out;
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
  // The selection is a node, not a row: rows move as agents start and end.
  const [sel, setSel] = useState<number | undefined>(undefined);
  const [onlyMessages, setOnlyMessages] = useState(false);
  /** The conversation view: which of the selected agent's partners it shows, or off. */
  const [talk, setTalk] = useState<number | undefined>(undefined);
  const rows = playgroundRows(snap);
  const found = rows.findIndex((r) => r.node.id === sel);
  const at = found >= 0 ? found : 0;
  const chosen = rows[at]?.node;
  const pals = chosen ? partners(snap, chosen.id) : [];
  const partner = talk === undefined || pals.length === 0 ? undefined : pals[talk % pals.length];

  useInput(
    (input, key) => {
      if (key.upArrow) return setSel(rows[Math.max(0, at - 1)]?.node.id);
      if (key.downArrow) return setSel(rows[Math.min(rows.length - 1, at + 1)]?.node.id);
      if (input === "m") return (setTalk(undefined), setOnlyMessages((v) => !v));
      if (input === "c") return setTalk((t) => (t === undefined ? 0 : undefined));
      if (key.tab && talk !== undefined) return setTalk((t) => (t ?? 0) + 1);
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

  const thread = chosen && partner !== undefined ? threadLines(snap, chosen.id, partner, feedW).slice(-Math.max(1, feedH - 1)) : undefined;
  const events = snap.events.filter((e) => !onlyMessages || e.kind === "message");
  const feed = events.slice(-Math.max(1, feedH - 1));
  const running = snap.nodes.filter((n) => n.status === "running").length;
  const roots = snap.nodes.filter((n) => n.kind === "root").length;

  const detail: string[] = [];
  if (chosen) {
    const links = chosen.kind === "root" ? linkedRoots(snap, chosen.id).map((n) => n.label) : [];
    detail.push(`${chosen.label} · ${chosen.kind === "root" ? "top-level" : `sub-agent, depth ${chosen.depth}`} · ${chosen.status}${chosen.kind === "sub" ? ` · ${chosen.access}` : ""}${chosen.model ? ` · ${usage(chosen)}` : ""}${links.length ? ` · ⇄ ${links.join(", ")}` : ""}`);
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
          <Text color={palette.faint} wrap="truncate-end">
            {talk === undefined
              ? onlyMessages
                ? "MESSAGES"
                : "ACTIVITY"
              : partner === undefined
                ? `CONVERSATION · ${chosen?.label ?? ""} has not exchanged a message yet`
                : `CONVERSATION · ${chosen!.label} ⇄ ${snap.labels.get(partner) ?? `#${partner}`}${pals.length > 1 ? ` · ${(talk % pals.length) + 1} of ${pals.length}, tab next` : ""}`}
          </Text>
          {thread
            ? thread.map((l, i) => (
                <Text key={i} color={l.tone} wrap="truncate-end">
                  {clip(l.text, feedW)}
                </Text>
              ))
            : null}
          {!thread && talk === undefined && feed.length === 0 ? <Text color={palette.faint}>nothing has happened yet</Text> : null}
          {(thread || talk !== undefined ? [] : feed).map((e, i) => {
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
        {p.width >= 80 ? `↑↓ select · enter open in the agents page · m ${onlyMessages ? "all activity" : "messages only"} · c ${talk === undefined ? "conversation" : "back to the feed"} · ^y back` : "↑↓ · enter open · m · c · ^y back"}
      </Text>
    </Box>
  );
}
