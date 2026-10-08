/**
 * The hub: every agent as a card, and the projects to start one in.
 *
 *   ←→↑↓ choose · enter open · s in/out of the split · x close · n new agent
 *
 * A card shows what its agent is doing, the prompt it is on, and a strip of
 * one pixel per turn (green done, red failed, violet escalated, magenta
 * running). An agent waiting on you is amber, here and in the tab bar.
 */
import React, { useState } from "react";
import * as os from "node:os";
import { Box, Text, useInput } from "ink";
import type { Agent } from "../runtime/fleet.ts";
import { turns, type Outcome } from "./activity.ts";
import { PixelArt } from "./components/PixelArt.tsx";
import { outcomeColor, Strip } from "./components/Strip.tsx";
import { mne, mneMini, pixelText } from "./pixel.ts";
import { palette, ground } from "./theme.ts";

export interface AgentState {
  kind: "idle" | "working" | "waiting";
  /** One glyph for tabs and rows. */
  glyph: string;
  tone: string;
  /** What it is doing, in a few words. */
  label: string;
  lastPrompt?: string;
  turns: number;
  outcomes: Outcome[];
  cost: number;
  model: string;
  branch?: string;
}

export function agentState(a: Agent): AgentState {
  const snap = a.controller.transcript.snapshot();
  const dialog = a.controller.dialogs.current();
  const footer = a.controller.snapshot().footer;
  const all = [...snap.committed, ...snap.live];
  const t = turns(all, snap.working !== null);
  const base = {
    lastPrompt: t.at(-1)?.prompt,
    turns: t.length,
    outcomes: t.map((x) => x.outcome),
    cost: footer.cost,
    model: footer.model,
    branch: footer.branch,
  };
  if (dialog) {
    const what = dialog.kind === "approval" ? `approve ${dialog.request.tool}` : "answer a question";
    return { ...base, kind: "waiting", glyph: "!", tone: palette.amber, label: `waiting for you · ${what}` };
  }
  if (snap.working) {
    const tool = [...snap.live].reverse().find((b) => b.kind === "tool" && b.status === "running");
    const secs = Math.round((Date.now() - snap.working.since) / 1000);
    const doing = tool && tool.kind === "tool" ? `running ${tool.name}` : "thinking";
    return { ...base, kind: "working", glyph: "●", tone: palette.magenta, label: `${doing} · ${secs}s` };
  }
  return { ...base, kind: "idle", glyph: "·", tone: palette.faint, label: t.length ? `idle · ${t.length} turn${t.length === 1 ? "" : "s"}` : "new · ready" };
}

const tilde = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

export interface HubProps {
  agents: readonly Agent[];
  states: Map<number, AgentState>;
  recent: readonly string[];
  split: readonly number[];
  width: number;
  height: number;
  active: boolean;
  onOpen: (id: number) => void;
  onSplit: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onOpenProject: (cwd: string) => void;
}

const CARD_H = 7;

function Card({ a, n, s, on, inSplit, width }: { a: Agent; n: number; s: AgentState | undefined; on: boolean; inSplit: boolean; width: number }) {
  const inner = width - 4;
  const tint = s?.kind === "waiting" ? palette.amber : s?.kind === "working" ? palette.magenta : palette.hide;
  return (
    <Box width={width} height={CARD_H} borderStyle="round" borderBackgroundColor={ground()} borderColor={on ? palette.magenta : s?.kind === "waiting" ? palette.amber : palette.rule} paddingX={1} flexDirection="column">
      <Box>
        <PixelArt grid={mneMini(tint)} />
        <Box flexDirection="column" marginLeft={1} width={inner - 8}>
          <Text wrap="truncate-end">
            <Text color={palette.dim}>{`${n} `}</Text>
            <Text bold color={palette.text}>
              {clip(a.name, inner - 22)}
            </Text>
            <Text color={palette.cyan}>{inSplit ? " ◫" : ""}</Text>
          </Text>
          <Text color={palette.faint} wrap="truncate-end">
            {clip(`${tilde(a.cwd)}${s?.branch ? ` ⎇ ${s.branch}` : ""}`, inner - 11)}
          </Text>
        </Box>
        <Text color={s?.tone ?? palette.faint}>{s?.glyph ?? "·"}</Text>
      </Box>
      <Text color={s?.kind === "waiting" ? palette.amber : s?.kind === "working" ? palette.magenta : palette.dim} wrap="truncate-end">
        {clip(s?.label ?? "", inner)}
      </Text>
      <Text color={palette.dim} wrap="truncate-end">
        {s?.lastPrompt ? clip(`“${s.lastPrompt.replace(/\s+/g, " ")}”`, inner) : " "}
      </Text>
      <Box>
        <Strip colors={(s?.outcomes ?? []).map(outcomeColor)} max={Math.max(4, inner - 12)} />
        <Box flexGrow={1} />
        <Text color={palette.faint}>{s && s.cost > 0 ? `$${s.cost.toFixed(3)}` : s?.model ?? ""}</Text>
      </Box>
    </Box>
  );
}

export function Hub(p: HubProps): React.ReactElement {
  const projects = p.recent.filter((r) => !p.agents.some((a) => a.cwd === r));
  const cols = p.width >= 150 ? 3 : p.width >= 96 ? 2 : 1;
  const cardW = Math.floor((p.width - 4) / cols);
  const count = p.agents.length + projects.length;
  const [sel, setSel] = useState(0);
  const at = Math.min(sel, Math.max(0, count - 1));
  const onAgent = at < p.agents.length ? p.agents[at] : undefined;
  const onProject = at >= p.agents.length ? projects[at - p.agents.length] : undefined;

  useInput(
    (input, key) => {
      const inCards = at < p.agents.length;
      if (key.leftArrow) return setSel(Math.max(0, at - 1));
      if (key.rightArrow) return setSel(Math.min(count - 1, at + 1));
      if (key.upArrow) return setSel(inCards ? Math.max(0, at - cols) : at === p.agents.length ? Math.max(0, p.agents.length - 1) : at - 1);
      if (key.downArrow) return setSel(inCards ? Math.min(count - 1, at + cols >= p.agents.length ? Math.max(at + cols, p.agents.length) : at + cols) : Math.min(count - 1, at + 1));
      if (input === "n") return p.onNew();
      if (key.return) {
        if (onAgent) return p.onOpen(onAgent.id);
        if (onProject) return p.onOpenProject(onProject);
      }
      if (!onAgent) return;
      if (input === "s") return p.onSplit(onAgent.id);
      if (input === "x") return p.onClose(onAgent.id);
    },
    { isActive: p.active },
  );

  const states = [...p.states.values()];
  const working = states.filter((s) => s.kind === "working").length;
  const waiting = states.filter((s) => s.kind === "waiting").length;
  const cost = states.reduce((n, s) => n + s.cost, 0);
  const tall = p.height >= 24;
  const rowsOfCards = Math.ceil(p.agents.length / cols);
  const roomForProjects = Math.max(0, p.height - (tall ? 10 : 3) - rowsOfCards * CARD_H - 4);

  return (
    <Box flexDirection="column" width={p.width} height={p.height} paddingX={2}>
      {tall ? (
        <Box marginTop={1}>
          <PixelArt grid={working ? mne.think : mne.idle} />
          <Box flexDirection="column" marginLeft={2} justifyContent="center">
            <PixelArt grid={pixelText("AGENTS", { shadow: palette.rule })} />
            <Text> </Text>
            <Text>
              <Text color={palette.text}>{`${p.agents.length} open`}</Text>
              <Text color={palette.magenta}>{working ? `   ● ${working} working` : ""}</Text>
              <Text color={palette.amber}>{waiting ? `   ! ${waiting} waiting for you` : ""}</Text>
              <Text color={palette.dim}>{cost > 0 ? `   $${cost.toFixed(3)} this session` : ""}</Text>
            </Text>
          </Box>
        </Box>
      ) : (
        <Text>
          <Text bold color={palette.magenta}>
            AGENTS{" "}
          </Text>
          <Text color={palette.text}>{`${p.agents.length} open`}</Text>
          <Text color={palette.amber}>{waiting ? `  ! ${waiting} waiting` : ""}</Text>
        </Text>
      )}
      <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
        {p.agents.map((a, i) => (
          <Card key={a.id} a={a} n={i + 1} s={p.states.get(a.id)} on={i === at} inSplit={p.split.includes(a.id)} width={cardW} />
        ))}
        {p.agents.length < cols * Math.max(1, rowsOfCards) || p.agents.length === 0 ? (
          <Box width={cardW} height={CARD_H} borderStyle="round" borderBackgroundColor={ground()} borderColor={palette.rule} justifyContent="center" alignItems="center">
            <Text color={palette.faint}>+ n new agent · ^p a project</Text>
          </Box>
        ) : null}
      </Box>
      {projects.length && roomForProjects > 1 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.faint}>RECENT PROJECTS</Text>
          {projects.slice(0, roomForProjects - 1).map((cwd, i) => {
            const on = p.agents.length + i === at;
            return (
              <Text key={cwd} backgroundColor={on ? palette.selectBg : undefined}>
                <Text color={on ? palette.magenta : palette.faint}>{on ? " ▸ " : "   "}</Text>
                <Text color={palette.cyan}>◇ </Text>
                <Text color={palette.text}>{clip(tilde(cwd), p.width - 12)}</Text>
              </Text>
            );
          })}
        </Box>
      ) : null}
      <Box flexGrow={1} />
      <Text color={palette.faint}>←→↑↓ choose · enter open · s split in/out · x close · n new agent · ^p projects · ^g back</Text>
    </Box>
  );
}
