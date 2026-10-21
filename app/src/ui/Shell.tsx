/**
 * The shell: every agent this process runs, and the screens to move between them.
 *
 *   agent   one agent's workspace, full screen (the default)
 *   split   up to four agents side by side, one of them focused
 *   hub     every agent at a glance: what each is doing, what waits on you,
 *           its sub-agents and the agents linked to it as siblings
 *   playground  every agent and what passes between them, read-only
 *
 * Keys, from anywhere:
 *   ctrl+g  hub              ctrl+p  switch project (or open one)
 *   ctrl+n  another agent on this project, in parallel
 *   ctrl+s  split / single   alt+l  next split layout   ctrl+y  playground
 *   alt+1…9 go to an agent   alt+, alt+.  previous, next (in a split, every pane:
 *                            a sub-agent's pane, focused, is a prompt to it; esc leaves it)
 *
 * Every agent's workspace stays mounted (hidden when off screen), so a draft,
 * a scroll position or an open dialog survives moving between screens.
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { Agent, Fleet } from "../runtime/fleet.ts";
import { MotionContext } from "./components/motion.ts";
import { palette, gradientAt, subscribeTheme, terminalColors, themeName, themePaints, ground } from "./theme.ts";
import { Workspace } from "./workspace/Workspace.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { samePath } from "./files.ts";
import { Hub, agentState, type AgentState } from "./Hub.tsx";
import { Playground } from "./Playground.tsx";
import { NodePane } from "./NodePane.tsx";
import { Roster } from "../runtime/roster.ts";
import { familyPanes, linkedRoots, runLine, subsOf, withNewSub } from "./tree.ts";
import { caret, chordMatches } from "../runtime/settings.ts";
import { useSettings } from "./settings-context.ts";
import { defaultLayout, fitsPanes, LAYOUT_LABEL, layoutsFor, nextLayout, SPLIT_MAX, splitRects, type SplitLayout } from "./layout.ts";
import { Toasts, useToasts } from "./Toasts.tsx";
import { ExitCard } from "./ExitCard.tsx";

export type Screen = "agent" | "split" | "hub" | "playground";

export interface ShellProps {
  fleet: Fleet;
  motion: boolean;
  /** Where to start (tests and snapshots). */
  initial?: { screen?: Screen; picker?: boolean };
}

/** What a shell with no agent reads from (never shown: it has no agents). */
const NO_ROSTER = new Roster();

/** A split pane is an agent (`a<id>`, the full workspace) or a sub-agent (`n<id>`, its view and a prompt to it). */
const agentKey = (id: number) => `a${id}`;

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

function FleetBar({
  agents,
  states,
  activeId,
  screen,
  columns,
  split,
}: {
  agents: readonly Agent[];
  states: Map<number, AgentState>;
  activeId: number | undefined;
  screen: Screen;
  columns: number;
  /** In a split: its layout, how many panes, and how many agents are related to the active one. */
  split?: { layout: SplitLayout; shown: number; related: number };
}): React.ReactElement {
  const k = useSettings();
  const hints = split
    ? `◫ ${LAYOUT_LABEL[split.layout]}${split.related > split.shown ? ` · ${split.shown} of ${split.related}` : ""}  ${caret(k["keys.layout"])} layout  ${caret(k["keys.hub"])} hub  ${caret(k["keys.playground"])} play `
    : `${caret(k["keys.hub"])} hub  ${caret(k["keys.projects"])} projects  ${caret(k["keys.newAgent"])} new  ${caret(k["keys.split"])} split  ${caret(k["keys.playground"])} play `;
  const showHints = columns >= 100;
  // One row, always: names shorten to share the room; with no room for names, numbers only.
  const room = columns - 9 - (screen === "hub" || screen === "playground" ? 6 : 0) - (showHints ? hints.length : 0);
  const perTab = Math.floor(room / Math.max(1, agents.length)) - 7;
  const nameMax = perTab >= 3 ? perTab : 0;
  const label = (name: string) => (nameMax === 0 ? "" : name.length > nameMax ? `${name.slice(0, Math.max(1, nameMax - 1))}…` : name);
  return (
    <Box width={columns}>
      <Text wrap="truncate-end">
        <Text color={palette.magenta}>▞</Text>
        <Text color={palette.cyan}>▚</Text>
        {[..." mnemo "].map((ch, i) => (
          <Text key={i} bold color={gradientAt(i / 6)}>
            {ch}
          </Text>
        ))}
        <Text color={screen === "hub" || screen === "playground" ? palette.text : palette.faint}>{screen === "hub" ? "▣ hub " : screen === "playground" ? "◈ play " : ""}</Text>
        {agents.map((a, i) => {
          const s = states.get(a.id);
          const on = a.id === activeId && screen !== "hub" && screen !== "playground";
          return (
            <Text key={a.id}>
              <Text color={palette.faint}>{" "}</Text>
              <Text backgroundColor={on ? palette.selectBg : undefined} color={on ? palette.text : palette.dim}>
                <Text color={on ? palette.magenta : palette.faint}>{nameMax ? ` ${i + 1} ` : ` ${i + 1}`}</Text>
                {label(a.name)}
                <Text color={s?.tone ?? palette.faint}>{` ${s?.glyph ?? "·"} `}</Text>
              </Text>
            </Text>
          );
        })}
      </Text>
      <Box flexGrow={1} />
      {showHints ? <Text color={palette.faint}>{hints}</Text> : null}
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
  // The tree of agents and sub-agents; every agent of a process shares one roster.
  const roster = agents[0]?.host.roster ?? NO_ROSTER;
  const tree = useSyncExternalStore(roster.subscribe, roster.snapshot);
  const { states, version } = useAgentStates(agents);
  const { columns, rows } = useWindowSize();
  const prefs = useSettings();
  /** The layout a split opens in: the one chosen in settings if it fits this many panes, else by terminal width. */
  const startLayout = (n: number): SplitLayout => (prefs.splitLayout !== "auto" && layoutsFor(n).includes(prefs.splitLayout) ? prefs.splitLayout : defaultLayout(n, columns));
  const [screen, setScreen] = useState<Screen>(initial?.screen ?? "agent");
  const [activeId, setActiveId] = useState<number | undefined>(agents[0]?.id);
  const [splitKeys, setSplitKeys] = useState<string[]>([]);
  const [layoutChoice, setLayoutChoice] = useState<SplitLayout | undefined>();
  const [picker, setPicker] = useState(initial?.picker ?? false);
  /** The picker was opened to start an agent (the hub's n), not to go to a project. */
  const [pickerFresh, setPickerFresh] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /** In a split, a sub-agent pane you moved to (`n<id>`); otherwise the active agent has the keys. */
  const [paneFocus, setPaneFocus] = useState<string | undefined>();

  // The active agent left: focus a neighbour.
  const active = agents.find((a) => a.id === activeId) ?? agents[0];
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active?.id]);

  // The split shows the chosen panes (agents, or sub-agents to watch), else the first four agents
  // with any room left to the active agent's sub-agents; never more than four, always the active agent.
  const split = useMemo(() => {
    const exists = (k: string) => (k[0] === "a" ? agents.some((a) => agentKey(a.id) === k) : tree.nodes.some((n) => `n${n.id}` === k));
    const chosen = splitKeys.filter(exists);
    const rootId = tree.nodes.find((n) => n.kind === "root" && n.agentId === active?.id)?.id;
    const subs = rootId === undefined ? [] : familyPanes(tree, rootId, SPLIT_MAX).keys.filter((k) => k[0] === "n");
    const keys = chosen.length >= 1 ? chosen : [...agents.slice(0, SPLIT_MAX).map((a) => agentKey(a.id)), ...subs];
    const mine = active ? agentKey(active.id) : undefined;
    return mine && !keys.includes(mine) ? [...keys.slice(0, SPLIT_MAX - 1), mine] : keys.slice(0, SPLIT_MAX);
  }, [splitKeys, agents, tree, active?.id]);
  const splitAgents = split.filter((k) => k[0] === "a").map((k) => Number(k.slice(1)));
  const nodeFocus = screen === "split" && paneFocus && split.includes(paneFocus) ? paneFocus : undefined;

  // A sub-agent that starts under an agent on screen joins the split (in a free pane, or one whose sub-agent ended).
  const seenSpawns = useRef<Set<number> | undefined>(undefined);
  useEffect(() => {
    const spawned = tree.events.filter((e) => e.kind === "spawn").map((e) => e.node);
    if (!seenSpawns.current) return void (seenSpawns.current = new Set(spawned));
    const fresh = spawned.filter((id) => !seenSpawns.current!.has(id));
    for (const id of fresh) seenSpawns.current.add(id);
    if (screen !== "split" || fresh.length === 0) return;
    let keys = split;
    for (const id of fresh) keys = withNewSub(keys, tree, id, SPLIT_MAX);
    if (keys.join() !== split.join()) setSplitKeys(keys);
  }, [tree]);

  // How many agents and sub-agents are related to the active one: more than the panes can show is said in the bar.
  const activeNode = tree.nodes.find((n) => n.kind === "root" && n.agentId === active?.id);
  const related = activeNode ? 1 + linkedRoots(tree, activeNode.id).length + subsOf(tree, activeNode.id).length : 1;

  const landing: Screen = screen === "hub" || screen === "playground" ? "agent" : screen;
  const go = (id: number, to: Screen = landing) => {
    setActiveId(id);
    setScreen(to);
    setPaneFocus(undefined);
  };
  const cycle = (delta: number) => {
    if (agents.length === 0) return;
    if (screen === "split" && split.length > 1) {
      const at = Math.max(0, split.indexOf(nodeFocus ?? (active ? agentKey(active.id) : "")));
      const k = split[(at + delta + split.length) % split.length]!;
      return k[0] === "a" ? go(Number(k.slice(1))) : setPaneFocus(k);
    }
    const pool = screen === "split" ? agents.filter((a) => splitAgents.includes(a.id)) : agents;
    const at = Math.max(0, pool.findIndex((a) => a.id === active?.id));
    go(pool[(at + delta + pool.length) % pool.length]!.id);
  };
  const open = async (cwd: string, fresh: boolean) => {
    setPicker(false);
    setPickerFresh(false);
    const existing = agents.find((a) => samePath(a.cwd, cwd));
    if (existing && !fresh) return go(existing.id, landing);
    try {
      const a = await fleet.open(cwd);
      setError(undefined);
      if (screen === "split") setSplitKeys((ks) => [...ks.filter((k) => k !== agentKey(a.id)), agentKey(a.id)].slice(-SPLIT_MAX));
      go(a.id, landing);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  /** Split the agent with the agents around it: its linked siblings, then its busiest sub-agents. */
  const splitWithFamily = (id: number) => {
    const root = tree.nodes.find((n) => n.kind === "root" && n.agentId === id);
    const keys = root ? familyPanes(tree, root.id, SPLIT_MAX).keys : [agentKey(id)];
    if (keys.length < 2) return setError("this agent has no linked or sub-agents to split with yet");
    setError(undefined);
    setSplitKeys(keys);
    setLayoutChoice(undefined);
    go(id, "split");
  };

  useInput(
    (input, key) => {
      if (chordMatches(prefs["keys.hub"], input, key)) return setScreen((s) => (s === "hub" ? "agent" : "hub"));
      if (chordMatches(prefs["keys.playground"], input, key)) return setScreen((s) => (s === "playground" ? "agent" : "playground"));
      if (chordMatches(prefs["keys.projects"], input, key)) return (setPickerFresh(false), setPicker(true));
      if (chordMatches(prefs["keys.newAgent"], input, key) && active) return void open(active.cwd, true);
      if (chordMatches(prefs["keys.split"], input, key)) return setScreen((s) => (s === "split" ? "agent" : "split"));
      if (chordMatches(prefs["keys.layout"], input, key) && screen === "split") return setLayoutChoice((l) => nextLayout(split.length, l ?? startLayout(split.length)));
      if (key.meta && /^[1-9]$/.test(input)) {
        const a = agents[Number(input) - 1];
        if (a) go(a.id);
        return;
      }
      if (key.escape && nodeFocus) return setPaneFocus(undefined);
      if (chordMatches(prefs["keys.prevAgent"], input, key)) return cycle(-1);
      if (chordMatches(prefs["keys.nextAgent"], input, key)) return cycle(1);
    },
    { isActive: !picker },
  );

  // What happens in an agent you are not looking at arrives as a toast.
  const toasts = useToasts(agents, (id) => (screen === "agent" && id === active?.id) || (screen === "split" && (id === active?.id || splitAgents.includes(id))), version);
  const body = rows - 1 - (error ? 1 : 0);
  // Every agent closed: the exit card, until the program ends.
  if (agents.length === 0)
    return (
      <MotionContext.Provider value={motion}>
        <ExitCard summary={snap.summary} width={columns} height={rows} />
      </MotionContext.Provider>
    );
  // A split needs room: below about 40×10 a pane, one agent is shown instead, and the bar says why.
  const layout: SplitLayout = layoutsFor(split.length).includes(layoutChoice as SplitLayout) ? layoutChoice! : startLayout(split.length);
  const tooSmall = screen === "split" && !fitsPanes(splitRects(split.length, layout, columns, body - 1));
  const view: Screen = tooSmall ? "agent" : screen;
  const main = body - (tooSmall ? 1 : 0);
  const rects = splitRects(split.length, layout, columns, main);
  const solo = { x: 0, y: 0, w: columns, h: main };
  const covered = screen === "hub" || screen === "playground";

  return (
    <MotionContext.Provider value={motion}>
      <Box flexDirection="column" width={columns} height={rows} backgroundColor={themePaints() ? palette.ground : undefined}>
        <FleetBar
          agents={agents}
          states={states}
          activeId={active?.id}
          screen={screen}
          columns={columns}
          split={screen === "split" && !tooSmall ? { layout, shown: split.length, related } : undefined}
        />
        {error ? <Text color={palette.magenta}>{` ✗ ${error}`}</Text> : null}
        {tooSmall ? <Text color={palette.amber} wrap="truncate-end">{columns >= 64 ? " the window is too small to split: showing one agent (^s back)" : " too small to split · ^s back"}</Text> : null}
        {screen === "hub" ? (
          <Hub
            agents={agents}
            states={states}
            recent={snap.recent}
            width={columns}
            height={body}
            active={!picker}
            split={splitAgents}
            roster={tree}
            onOpen={(id) => go(id, "agent")}
            onSplit={(id) => {
              // The agent you are in is always in the split, so taking it out would do nothing.
              if (id === active?.id && split.includes(agentKey(id))) return setError("the agent you are in always stays in the split");
              setError(undefined);
              setSplitKeys((ks) => {
                const k = agentKey(id);
                // Toggle against what the split shows now, which is the first four until you choose.
                const now = ks.length ? ks : split;
                return now.includes(k) ? now.filter((x) => x !== k) : [...now, k].slice(-SPLIT_MAX);
              });
            }}
            onClose={(id) => void fleet.close(id)}
            onNew={() => (setPickerFresh(true), setPicker(true))}
            onOpenProject={(cwd) => void open(cwd, false)}
            onLink={(a, b) => {
              if (!fleet.link(a, b)) setError("those two cannot be linked");
              else setError(undefined);
            }}
            onUnlink={(id) => void fleet.unlink(id)}
            onFamily={splitWithFamily}
            onPlayground={() => setScreen("playground")}
            onStopRun={(id) => {
              const r = fleet.stopRun(id);
              setError(r ? undefined : "that agent is not in a run");
              if (r) agents.find((a) => a.id === id)?.controller.transcript.notice(`Stopped run ${r.run}: ${r.agents} agent${r.agents === 1 ? "" : "s"} were still working.`, "warn");
            }}
          />
        ) : null}
        {screen === "playground" ? (
          <Playground
            roster={roster}
            width={columns}
            height={body}
            active={!picker}
            onOpen={(rootNode) => {
              const a = agents.find((o) => o.host.node === rootNode);
              if (a) go(a.id, "agent");
            }}
          />
        ) : null}
        <Box width={columns} height={covered ? 0 : main} display={covered ? "none" : "flex"}>
          {agents.map((a) => {
            const at = split.indexOf(agentKey(a.id));
            const inSplit = view === "split" && at >= 0;
            const shown = view === "agent" ? a.id === active?.id : inSplit;
            const focused = a.id === active?.id && !picker && !(view === "split" && nodeFocus);
            const framed = view === "split";
            const r = framed && at >= 0 ? rects[at]! : solo;
            return (
              <Box
                key={a.id}
                position="absolute"
                left={r.x}
                top={r.y}
                display={shown ? "flex" : "none"}
                width={r.w}
                height={r.h}
                borderStyle={framed ? "round" : undefined} borderBackgroundColor={ground()}
                borderColor={focused ? palette.magenta : palette.faint}
              >
                <Workspace
                  controller={a.controller}
                  source={a.source}
                  motion={motion && shown}
                  width={framed ? r.w - 2 : r.w}
                  height={framed ? r.h - 2 : r.h}
                  active={shown && focused}
                  compact={framed}
                  brand={false}
                  agents={agents.filter((o) => o.id !== a.id).map((o) => ({ label: o.name, go: () => go(o.id) }))}
                />
              </Box>
            );
          })}
          {view === "split"
            ? split.map((k, i) => {
                if (k[0] !== "n") return null;
                const node = tree.nodes.find((n) => `n${n.id}` === k);
                if (!node) return null;
                const r = rects[i]!;
                const on = nodeFocus === k && !picker;
                return (
                  <Box key={k} position="absolute" left={r.x} top={r.y} width={r.w} height={r.h} borderStyle="round" borderBackgroundColor={ground()} borderColor={on ? palette.magenta : palette.faint}>
                    <NodePane node={node} nodes={tree.nodes} width={r.w - 2} height={r.h - 2} focused={on} onTell={(text) => roster.tell(node.id, text)} run={runLine(tree, node)} />
                  </Box>
                );
              })
            : null}
        </Box>
        <Toasts toasts={toasts} columns={columns} />
        {picker ? (
          <ProjectPicker
            fleet={snap}
            current={active?.cwd}
            fresh={pickerFresh}
            width={columns}
            onPick={(cwd, fresh) => void open(cwd, fresh)}
            onCancel={() => (setPicker(false), setPickerFresh(false))}
          />
        ) : null}
      </Box>
    </MotionContext.Provider>
  );
}
