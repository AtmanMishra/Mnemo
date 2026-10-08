/**
 * The shell: every agent this process runs, and the screens to move between them.
 *
 *   agent   one agent's workspace, full screen (the default)
 *   split   up to four agents side by side, one of them focused
 *   hub     every agent at a glance: what each is doing, what waits on you
 *
 * Keys, from anywhere:
 *   ctrl+g  hub              ctrl+p  switch project (or open one)
 *   ctrl+n  another agent on this project, in parallel
 *   ctrl+s  split / single   alt+1…9 go to an agent   alt+, alt+.  previous, next
 *
 * Every agent's workspace stays mounted (hidden when off screen), so a draft,
 * a scroll position or an open dialog survives moving between screens.
 */
import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { Agent, Fleet } from "../runtime/fleet.ts";
import { MotionContext } from "./components/motion.ts";
import { palette, gradientAt, subscribeTheme, terminalColors, themeName, themePaints, ground } from "./theme.ts";
import { Workspace } from "./workspace/Workspace.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { Hub, agentState, type AgentState } from "./Hub.tsx";
import { Toasts, useToasts } from "./Toasts.tsx";
import { ExitCard } from "./ExitCard.tsx";

export type Screen = "agent" | "split" | "hub";

export interface ShellProps {
  fleet: Fleet;
  motion: boolean;
  /** Where to start (tests and snapshots). */
  initial?: { screen?: Screen; picker?: boolean };
}

const SPLIT_MAX = 4;

/** Re-render when any agent's transcript, chrome or dialogs change. */
function useAgentStates(agents: readonly Agent[]): { states: Map<number, AgentState>; version: number } {
  const [version, bump] = useState(0);
  useEffect(() => {
    let queued = false;
    const kick = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        bump((n) => n + 1);
      }, 50);
    };
    const offs = agents.flatMap((a) => [a.controller.transcript.subscribe(kick), a.controller.subscribe(kick), a.controller.dialogs.subscribe(kick)]);
    return () => offs.forEach((off) => off());
  }, [agents]);
  return { states: new Map(agents.map((a) => [a.id, agentState(a)])), version };
}

/** Columns × rows for n panes. */
export function splitGrid(n: number, columns: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return columns >= 180 ? { cols: 3, rows: 1 } : { cols: 2, rows: 2 };
  return { cols: 2, rows: 2 };
}

function FleetBar({
  agents,
  states,
  activeId,
  screen,
  columns,
}: {
  agents: readonly Agent[];
  states: Map<number, AgentState>;
  activeId: number | undefined;
  screen: Screen;
  columns: number;
}): React.ReactElement {
  const hints = "^g hub  ^p projects  ^n new  ^s split ";
  return (
    <Box width={columns}>
      <Text>
        <Text color={palette.magenta}>▞</Text>
        <Text color={palette.cyan}>▚</Text>
        {[..." mnemo "].map((ch, i) => (
          <Text key={i} bold color={gradientAt(i / 6)}>
            {ch}
          </Text>
        ))}
        <Text color={screen === "hub" ? palette.text : palette.faint}>{screen === "hub" ? "▣ hub " : ""}</Text>
        {agents.map((a, i) => {
          const s = states.get(a.id);
          const on = a.id === activeId && screen !== "hub";
          return (
            <Text key={a.id}>
              <Text color={palette.faint}>{" "}</Text>
              <Text backgroundColor={on ? palette.selectBg : undefined} color={on ? palette.text : palette.dim}>
                <Text color={on ? palette.magenta : palette.faint}>{` ${i + 1} `}</Text>
                {a.name}
                <Text color={s?.tone ?? palette.faint}>{` ${s?.glyph ?? "·"} `}</Text>
              </Text>
            </Text>
          );
        })}
      </Text>
      <Box flexGrow={1} />
      {columns >= 100 ? <Text color={palette.faint}>{hints}</Text> : null}
    </Box>
  );
}

export function Shell({ fleet, motion, initial }: ShellProps): React.ReactElement {
  const snap = useSyncExternalStore(fleet.subscribe, fleet.snapshot);
  // A theme change re-draws everything; light themes paint their own ground.
  const theme = useSyncExternalStore(subscribeTheme, themeName);
  // In a real terminal, its own default colours follow the theme too.
  useEffect(() => {
    if (motion && process.stdout.isTTY) process.stdout.write(terminalColors());
  }, [theme]);
  const agents = snap.agents;
  const { states, version } = useAgentStates(agents);
  const { columns, rows } = useWindowSize();
  const [screen, setScreen] = useState<Screen>(initial?.screen ?? "agent");
  const [activeId, setActiveId] = useState<number | undefined>(agents[0]?.id);
  const [splitIds, setSplitIds] = useState<number[]>([]);
  const [picker, setPicker] = useState(initial?.picker ?? false);
  const [error, setError] = useState<string | undefined>();

  // The active agent left: focus a neighbour.
  const active = agents.find((a) => a.id === activeId) ?? agents[0];
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active?.id]);

  // The split shows the chosen agents, else the first four, always including the active one.
  const split = useMemo(() => {
    const chosen = splitIds.filter((id) => agents.some((a) => a.id === id));
    const ids = chosen.length >= 2 ? chosen : agents.slice(0, SPLIT_MAX).map((a) => a.id);
    return active && !ids.includes(active.id) ? [...ids.slice(0, SPLIT_MAX - 1), active.id] : ids.slice(0, SPLIT_MAX);
  }, [splitIds, agents, active?.id]);

  const go = (id: number, to: Screen = screen === "hub" ? "agent" : screen) => {
    setActiveId(id);
    setScreen(to);
  };
  const cycle = (delta: number) => {
    if (agents.length === 0) return;
    const pool = screen === "split" ? agents.filter((a) => split.includes(a.id)) : agents;
    const at = Math.max(0, pool.findIndex((a) => a.id === active?.id));
    go(pool[(at + delta + pool.length) % pool.length]!.id);
  };
  const open = async (cwd: string, fresh: boolean) => {
    setPicker(false);
    const existing = agents.find((a) => a.cwd === cwd);
    if (existing && !fresh) return go(existing.id, screen === "hub" ? "agent" : screen);
    try {
      const a = await fleet.open(cwd);
      setError(undefined);
      if (screen === "split") setSplitIds((ids) => [...ids.filter((id) => id !== a.id), a.id].slice(-SPLIT_MAX));
      go(a.id, screen === "hub" ? "agent" : screen);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "g") return setScreen((s) => (s === "hub" ? "agent" : "hub"));
      if (key.ctrl && input === "p") return setPicker(true);
      if (key.ctrl && input === "n" && active) return void open(active.cwd, true);
      if (key.ctrl && input === "s") return setScreen((s) => (s === "split" ? "agent" : "split"));
      if (key.meta && /^[1-9]$/.test(input)) {
        const a = agents[Number(input) - 1];
        if (a) go(a.id);
        return;
      }
      if (key.meta && input === ",") return cycle(-1);
      if (key.meta && input === ".") return cycle(1);
    },
    { isActive: !picker },
  );

  // What happens in an agent you are not looking at arrives as a toast.
  const toasts = useToasts(agents, (id) => screen !== "hub" && (id === active?.id || (screen === "split" && split.includes(id))), version);
  const body = rows - 1 - (error ? 1 : 0);
  // Every agent closed: the exit card, until the program ends.
  if (agents.length === 0)
    return (
      <MotionContext.Provider value={motion}>
        <ExitCard summary={snap.summary} width={columns} height={rows} />
      </MotionContext.Provider>
    );
  const grid = splitGrid(split.length, columns);
  const paneW = Math.floor(columns / grid.cols);
  const paneH = Math.floor(body / grid.rows);

  return (
    <MotionContext.Provider value={motion}>
      <Box flexDirection="column" width={columns} height={rows} backgroundColor={themePaints() ? palette.ground : undefined}>
        <FleetBar agents={agents} states={states} activeId={active?.id} screen={screen} columns={columns} />
        {error ? <Text color={palette.magenta}>{` ✗ ${error}`}</Text> : null}
        {screen === "hub" ? (
          <Hub
            agents={agents}
            states={states}
            recent={snap.recent}
            width={columns}
            height={body}
            active={!picker}
            split={split}
            onOpen={(id) => go(id, "agent")}
            onSplit={(id) =>
              setSplitIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...(ids.length ? ids : split), id].slice(-SPLIT_MAX)))
            }
            onClose={(id) => void fleet.close(id)}
            onNew={() => setPicker(true)}
            onOpenProject={(cwd) => void open(cwd, false)}
          />
        ) : null}
        <Box flexDirection="row" flexWrap="wrap" width={columns} height={screen === "hub" ? 0 : body} display={screen === "hub" ? "none" : "flex"}>
          {agents.map((a) => {
            const inSplit = screen === "split" && split.includes(a.id);
            const shown = screen === "agent" ? a.id === active?.id : inSplit;
            const focused = a.id === active?.id && !picker;
            const framed = screen === "split";
            // Three in a 2×2 grid: the last one takes the whole bottom row.
            const last = framed && split.length === 3 && grid.cols === 2 && split.indexOf(a.id) === 2;
            const w = framed ? (last ? paneW * 2 : paneW) : columns;
            const h = framed ? paneH : body;
            return (
              <Box
                key={a.id}
                display={shown ? "flex" : "none"}
                width={w}
                height={h}
                borderStyle={framed ? "round" : undefined} borderBackgroundColor={ground()}
                borderColor={focused ? palette.magenta : palette.faint}
              >
                <Workspace
                  controller={a.controller}
                  source={a.source}
                  motion={motion && shown}
                  width={framed ? w - 2 : w}
                  height={framed ? h - 2 : h}
                  active={shown && focused}
                  compact={framed}
                  brand={false}
                />
              </Box>
            );
          })}
        </Box>
        <Toasts toasts={toasts} columns={columns} />
        {picker ? (
          <ProjectPicker
            fleet={snap}
            current={active?.cwd}
            width={columns}
            onPick={(cwd, fresh) => void open(cwd, fresh)}
            onCancel={() => setPicker(false)}
          />
        ) : null}
      </Box>
    </MotionContext.Provider>
  );
}
