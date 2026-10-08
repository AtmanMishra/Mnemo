/**
 * The workspace: the whole terminal, one surface.
 *
 *   header    ▞▚ mnemo · repo ⎇ branch                ◆ model  ◈ 412  $0.03
 *   sidebar   ▤ files · ◈ memory · ▣ sessions · ◇ skills · ≡ logs   (ctrl+b)
 *   main      the transcript, scrolling, or a preview of what the sidebar
 *             has selected (a file, a memory, a session, a skill)
 *   composer  the prompt, its menus and the footer
 *
 * Focus is one of composer, sidebar, main: tab moves on (from the composer
 * only when no completion is open), esc comes back to the composer. In the
 * sidebar: ↑↓ move, → or enter open, ← close, 1–5 switch panes, and a
 * pane's own keys (r resumes a session, i puts @file in the prompt). PgUp and
 * PgDn scroll the main area from anywhere.
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useAnimation, useBoxMetrics, useInput, useWindowSize, type DOMElement } from "ink";
import type { Controller } from "../../runtime/controller.ts";
import { BlockView } from "../components/Blocks.tsx";
import { Composer } from "../components/Composer.tsx";
import { DialogView, InputActive } from "../components/Dialogs.tsx";
import { MotionContext } from "../components/motion.ts";
import { WorkingLine } from "../components/Working.tsx";
import { RaceView } from "../components/Race.tsx";
import { MneBadge, useFresh, type MneMood } from "../components/MneBadge.tsx";
import { gradientAt, palette } from "../theme.ts";
import { fileTree, PANES, type Item, type Pane, type Preview, type WorkspaceSource } from "./model.ts";
import { Bar, PreviewView, Viewport } from "./Main.tsx";
import { PixelArt } from "../components/PixelArt.tsx";
import { mne } from "../pixel.ts";
import { PANE_ICON, Sidebar } from "./Sidebar.tsx";
import { MemoryMap, layoutMap } from "./MemoryMap.tsx";
import { turns as turnsOf } from "../activity.ts";
import { outcomeColor, Strip } from "../components/Strip.tsx";
import { decorateFiles } from "./decorate.ts";

export type Focus = "composer" | "sidebar" | "main";

const SIDEBAR_MIN_COLUMNS = 84;
const SIDEBAR_WIDTH = 34;
const TRANSCRIPT_BLOCKS = 80;
const TIMELINE_MAX = 24;

function Header({ controller, columns, brand, mood }: { controller: Controller; columns: number; brand: boolean; mood: MneMood }): React.ReactElement {
  const chrome = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const f = chrome.footer;
  const repo = f.cwd.split("/").filter(Boolean).at(-1) ?? f.cwd;
  // The right side gives way first: the model name is cut, then the branch goes.
  const narrow = columns < 70;
  return (
    <Box width={columns}>
      <Box flexShrink={0}>
        <Text>
          {brand ? (
            <>
              <Text color={palette.magenta}>▞</Text>
              <Text color={palette.cyan}>▚</Text>
              <Text bold>
                {[..." mnemo"].map((ch, i) => (
                  <Text key={i} color={gradientAt(i / 5)}>
                    {ch}
                  </Text>
                ))}
              </Text>
              <Text color={palette.text}>{`  ${repo}`}</Text>
            </>
          ) : (
            <Text bold color={palette.text}>{` ${repo}`}</Text>
          )}
          <Text> </Text>
          <MneBadge mood={mood} activity={chrome.activity} />
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text wrap="truncate-start">
          {f.branch && !narrow ? <Text color={palette.dim}>{`⎇ ${f.branch}  `}</Text> : null}
          <Text color={palette.magenta}>◆ </Text>
          <Text color={palette.text}>{f.model}</Text>
          <Text color={f.memory ? palette.amber : palette.faint}>{`  ${f.memory ? `◈ ${f.memory.nodes}` : "◈ off"}`}</Text>
          {f.cost > 0 ? <Text color={palette.dim}>{`  $${f.cost.toFixed(2)}`}</Text> : null}
          <Text> </Text>
        </Text>
      </Box>
    </Box>
  );
}

/** Mne, waiting: a blink every few seconds when motion is on. */
function IdleMne(): React.ReactElement {
  const motion = React.useContext(MotionContext);
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (!motion) return;
    const id = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 160);
    }, 4200);
    return () => clearInterval(id);
  }, [motion]);
  return (
    <Box marginBottom={1}>
      <PixelArt grid={blink ? mne.blink : mne.idle} />
    </Box>
  );
}

export interface WorkspaceProps {
  controller: Controller;
  source: WorkspaceSource;
  motion: boolean;
  /** Where to start (tests and snapshots). */
  initial?: { focus?: Focus; pane?: Pane; openDirs?: string[]; selected?: number; map?: boolean };
  /** The space it has (default: the whole terminal). */
  width?: number;
  height?: number;
  /** Whether it takes keys: false for the agents in a split that are not focused. */
  active?: boolean;
  /** A split pane: no sidebar, a one-line header. */
  compact?: boolean;
  /** The wordmark in the header (off inside the shell, whose tab bar has it). */
  brand?: boolean;
}

export function Workspace({ controller, source, motion, initial, width, height, active = true, compact = false, brand = true }: WorkspaceProps): React.ReactElement {
  const snap = useSyncExternalStore(controller.transcript.subscribe, controller.transcript.snapshot);
  const chrome = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const dialog = useSyncExternalStore(controller.dialogs.subscribe, controller.dialogs.current);
  const size = useWindowSize();
  const columns = width ?? size.columns;
  const rows = height ?? size.rows;
  const cwd = controller.runtime.cwd;

  const [sidebar, setSidebar] = useState(!compact && columns >= SIDEBAR_MIN_COLUMNS);
  const [focus, setFocus] = useState<Focus>(initial?.focus ?? "composer");
  const [pane, setPane] = useState<Pane>(initial?.pane ?? "files");
  const [selected, setSelected] = useState<Record<Pane, number>>(() => {
    const s = { files: 0, memory: 0, sessions: 0, skills: 0, logs: 0 };
    if (initial?.selected !== undefined) s[initial.pane ?? "files"] = initial.selected;
    return s;
  });
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set(initial?.openDirs ?? []));
  const [loaded, setLoaded] = useState<Partial<Record<Pane, Item[]>>>({});
  const [preview, setPreview] = useState<Preview | undefined>();
  const [back, setBack] = useState(0);
  const [previewBack, setPreviewBack] = useState(0);
  /** The memory map is open in the main area, and which node is selected. */
  const [map, setMap] = useState<number | undefined>(initial?.map ? 0 : undefined);
  /** A turn picked on the timeline: the transcript shows from there. */
  const [turnSel, setTurnSel] = useState<number | undefined>(undefined);
  const contentHeight = useRef(0);

  // The rows of each pane: files from the tree, the rest from the source.
  const files = useMemo(() => source.files(), [source]);
  const tree = useMemo(() => fileTree(files, openDirs), [files, openDirs]);
  const decorated = useMemo(() => decorateFiles(tree, [...snap.committed, ...snap.live], cwd, source.fileSize), [tree, snap.committed, snap.live]);
  const items: Item[] = pane === "files" ? decorated : (loaded[pane] ?? []);
  const sel = Math.min(selected[pane], Math.max(0, items.length - 1));
  const current = items[sel];

  const load = async (p: Pane) => {
    if (p === "files") return;
    const next = p === "memory" ? await source.memory() : p === "sessions" ? await source.sessions() : p === "skills" ? source.skills() : source.logs();
    setLoaded((l) => ({ ...l, [p]: next }));
  };
  useEffect(() => void load(pane), [pane]);
  // After each run: memory, sessions and logs have moved on.
  const working = snap.working !== null;
  useEffect(() => {
    if (!working) void load(pane);
  }, [working]);

  // Moving through the sidebar previews what is under the cursor.
  useEffect(() => {
    if (focus !== "sidebar" || !current || current.kind === "dir" || current.kind === "head") return;
    let live = true;
    const t = setTimeout(() => {
      void source.preview(pane, current.id).then((p) => {
        if (live) {
          setPreview(p);
          setPreviewBack(0);
        }
      });
    }, 60);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [focus, pane, current?.id]);

  const body = useRef<DOMElement>(null);
  const { height: bodyHeight } = useBoxMetrics(body);
  const mainHeight = Math.max(3, bodyHeight - 1);
  const showSidebar = sidebar && !compact && columns >= 60;
  const mainWidth = columns - (showSidebar ? SIDEBAR_WIDTH : 0);

  const transcriptBlocks = snap.committed.filter((b) => b.kind !== "welcome");
  const turnList = useMemo(() => turnsOf([...transcriptBlocks, ...snap.live], snap.working !== null), [snap.committed, snap.live, snap.working]);
  const mapNodes = useMemo(() => (map === undefined ? [] : layoutMap(loaded.memory ?? [], mainWidth - 2, mainHeight).nodes), [map !== undefined, loaded.memory, mainWidth, mainHeight]);
  const move = (delta: number) => setSelected((s) => ({ ...s, [pane]: Math.max(0, Math.min(items.length - 1, sel + delta)) }));
  const nextFocus = (from: Focus): Focus => (from === "composer" ? (showSidebar ? "sidebar" : "main") : from === "sidebar" ? "main" : "composer");

  useInput(
    (input, key) => {
      if (key.ctrl && input === "b" && !compact) {
        setSidebar((v) => !v);
        if (focus === "sidebar") setFocus("composer");
        return;
      }
      const page = Math.max(1, mainHeight - 2);
      if (key.pageUp) return preview ? setPreviewBack((b) => b + page) : setBack((b) => Math.min(b + page, Math.max(0, contentHeight.current - mainHeight)));
      if (key.pageDown) return preview ? setPreviewBack((b) => Math.max(0, b - page)) : setBack((b) => Math.max(0, b - page));
      if (focus === "composer") return;
      if (key.tab) return setFocus(nextFocus(focus));
      if (key.escape) {
        if (focus === "main" && map !== undefined) return setMap(undefined);
        if (focus === "main" && preview) return setPreview(undefined);
        if (focus === "main" && turnSel !== undefined) return setTurnSel(undefined);
        return setFocus("composer");
      }
      if (focus === "main" && map !== undefined) {
        const n = mapNodes.length;
        if (key.leftArrow || key.upArrow) return setMap((m) => ((m ?? 0) - 1 + Math.max(1, n)) % Math.max(1, n));
        if (key.rightArrow || key.downArrow) return setMap((m) => ((m ?? 0) + 1) % Math.max(1, n));
        const node = mapNodes[map];
        if (key.return && node?.id.startsWith("n:")) {
          setMap(undefined);
          void source.preview("memory", node.id).then((p) => p && setPreview(p));
        }
        return;
      }
      if (focus === "main" && !preview && (input === "[" || input === "]" || key.leftArrow || key.rightArrow)) {
        if (turnList.length === 0) return;
        const prev = input === "[" || key.leftArrow;
        return setTurnSel((t) => {
          const at = t ?? turnList.length;
          const next = prev ? Math.max(0, at - 1) : at + 1;
          return next >= turnList.length ? undefined : next;
        });
      }
      if (focus === "main") {
        if (key.upArrow) return preview ? setPreviewBack((b) => b + 1) : setBack((b) => b + 1);
        if (key.downArrow) return preview ? setPreviewBack((b) => Math.max(0, b - 1)) : setBack((b) => Math.max(0, b - 1));
        if (input === "x" && preview) return setPreview(undefined);
        return;
      }
      // The sidebar.
      if (pane === "memory" && input === "m") {
        if (!loaded.memory) void load("memory");
        setPreview(undefined);
        setMap(0);
        return setFocus("main");
      }
      const n = Number(input);
      if (!key.meta && n >= 1 && n <= PANES.length) return setPane(PANES[n - 1]!);
      if (key.upArrow) return move(-1);
      if (key.downArrow) return move(1);
      if (!current) return;
      if (current.kind === "dir" && (key.return || key.rightArrow || key.leftArrow)) {
        const open = !(current.open ?? false);
        if (key.leftArrow && !current.open) return;
        if (key.rightArrow && current.open) return;
        return setOpenDirs((s) => {
          const next = new Set(s);
          if (open) next.add(current.id);
          else next.delete(current.id);
          return next;
        });
      }
      if (key.leftArrow && pane === "files" && current.id.includes("/")) {
        const parent = current.id.slice(0, current.id.lastIndexOf("/"));
        const at = items.findIndex((i) => i.id === parent);
        if (at >= 0) return setSelected((s) => ({ ...s, files: at }));
      }
      if (key.return || key.rightArrow) return setFocus("main");
      if (input && !key.ctrl && !key.meta) source.act(pane, current.id, input);
    },
    { isActive: active && !dialog },
  );

  const runningTool = snap.live.some((b) => b.kind === "tool" && b.status === "running");
  // Something learned: the memory tab animates it in for a few seconds.
  const learnedFresh = useFresh(chrome.activity?.kind === "learned" ? chrome.activity : undefined);
  const { frame: dropFrame } = useAnimation({ interval: 120, isActive: motion && learnedFresh });
  const dropAge = motion ? dropFrame * 120 : 1000;
  const escalated = snap.working !== null && chrome.activity?.kind === "escalated" && chrome.activity.at >= snap.working.since;
  const mood: MneMood = dialog ? "waiting" : snap.working ? (runningTool ? "tool" : "thinking") : "idle";
  const fromTurn = turnSel !== undefined ? turnList[turnSel] : undefined;
  const blocks = fromTurn ? transcriptBlocks.slice(fromTurn.at) : transcriptBlocks.slice(-TRANSCRIPT_BLOCKS);
  const render = (b: (typeof snap.committed)[number]) => <BlockView key={b.id} block={b} cwd={cwd} expanded={chrome.expanded} />;
  const empty = blocks.length === 0 && snap.live.length === 0 && !snap.working && !chrome.race;

  return (
    <MotionContext.Provider value={motion}>
      <Box flexDirection="column" width={columns} height={rows}>
        <Header controller={controller} columns={columns} brand={brand} mood={mood} />
        <Box ref={body} flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
          {showSidebar ? (
            <Sidebar
              pane={pane}
              items={items}
              selected={sel}
              focused={focus === "sidebar"}
              width={SIDEBAR_WIDTH}
              height={bodyHeight}
              learned={learnedFresh && chrome.activity ? { count: chrome.activity.count ?? 1, age: dropAge } : undefined}
            />
          ) : null}
          <Box flexDirection="column" width={mainWidth} paddingLeft={showSidebar ? 1 : 0}>
            {map !== undefined && focus !== "composer" ? (
              <>
                <Bar title="memory map" width={mainWidth - 1} focused={focus === "main"} />
                <MemoryMap items={loaded.memory ?? []} project={cwd.split("/").filter(Boolean).at(-1) ?? cwd} width={mainWidth - 2} height={mainHeight} selected={map} />
              </>
            ) : preview && focus !== "composer" ? (
              <>
                <Bar title={`${PANE_ICON[pane]} ${preview.title}`} subtitle={[preview.subtitle, preview.hint].filter(Boolean).join(" · ")} width={mainWidth - 1} focused={focus === "main"} />
                <PreviewView preview={preview} width={mainWidth - 2} height={mainHeight} back={previewBack} />
              </>
            ) : (
              <>
                <Bar
                  title="transcript"
                  subtitle={
                    fromTurn ? `turn ${turnSel! + 1}/${turnList.length} · [ ] move · esc follow` : back > 0 ? `${back} rows up · PgDn to follow` : undefined
                  }
                  width={mainWidth - 1}
                  focused={focus === "main"}
                  extra={turnList.length ? <Strip colors={turnList.map((t) => outcomeColor(t.outcome))} max={TIMELINE_MAX} selected={turnSel} /> : undefined}
                  extraWidth={Math.min(turnList.length, TIMELINE_MAX) + (turnList.length > TIMELINE_MAX ? 1 : 0)}
                />
                {empty ? (
                  <Box height={mainHeight} flexDirection="column" justifyContent="center" alignItems="center">
                    {mainHeight >= 16 ? <IdleMne /> : null}
                    <Text color={palette.dim}>Ask anything about this project.</Text>
                    <Text color={palette.faint}>/ commands · @ files · tab sidebar · ctrl+b hide it</Text>
                  </Box>
                ) : (
                  <Viewport height={mainHeight} back={fromTurn ? Number.MAX_SAFE_INTEGER : back} onMeasure={(h) => (contentHeight.current = h)}>
                    {blocks.map(render)}
                    {fromTurn ? null : snap.live.map(render)}
                    {chrome.race && !fromTurn ? <RaceView race={chrome.race} width={mainWidth - 2} /> : null}
                    {chrome.workingVisible ? <WorkingLine
                        working={snap.working}
                        message={dialog ? "Waiting for you…" : chrome.workingMessage}
                        queue={snap.queue}
                        mode={dialog ? "wait" : runningTool ? "tool" : "think"}
                        escalated={escalated}
                      /> : null}
                  </Viewport>
                )}
              </>
            )}
          </Box>
        </Box>
        {dialog ? (
          <InputActive.Provider value={active}>
            <DialogView dialog={dialog} />
          </InputActive.Provider>
        ) : null}
        <Composer
          working={snap.working !== null}
          active={active && !dialog && focus === "composer"}
          commands={() => controller.commands()}
          files={() => files}
          footer={chrome.footer}
          statuses={chrome.statuses}
          draftRequest={chrome.draftRequest}
          onSubmit={(text, mode) => {
            setBack(0);
            void controller.submit(text, mode);
          }}
          onInterrupt={() => controller.interrupt()}
          onQuit={() => void controller.quit()}
          onDraft={(t) => controller.reportDraft(t)}
          onToggleExpanded={() => controller.toggleExpanded()}
          onClear={() => controller.transcript.clear()}
          onCycleThinking={() => controller.cycleThinking()}
          onCycleMode={() => controller.cycleMode()}
          onFocusNext={() => setFocus(nextFocus("composer"))}
        />
      </Box>
    </MotionContext.Provider>
  );
}
