/**
 * The input box and everything under it: the slash and `@file` menus, the
 * shortcuts panel and the footer. Key rules are in DESIGN.md §6.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import type { CommandInfo, Footer as FooterData } from "../../runtime/controller.ts";
import { color, glyph, ground } from "../theme.ts";
import * as ed from "../editor.ts";
import { matchFiles, subsequence } from "../files.ts";
import { Footer } from "./Footer.tsx";

export interface ComposerProps {
  working: boolean;
  /** False while a dialog owns the keyboard. */
  active: boolean;
  commands: () => CommandInfo[];
  files: () => readonly string[];
  footer: FooterData;
  statuses: readonly [string, string][];
  draftRequest?: { text: string; seq: number };
  onSubmit: (text: string, mode: "auto" | "steer") => void;
  onInterrupt: () => void;
  onQuit: () => void;
  onDraft: (text: string) => void;
  onToggleExpanded: () => void;
  onClear: () => void;
  onCycleThinking: () => void;
  onCycleMode: () => void;
  /** Tab with no completion open: move focus on (the workspace's sidebar). */
  onFocusNext?: () => void;
}

type Suggestion = { value: string; label: string; detail?: string };

const MENU = 8;
const DOUBLE_PRESS_MS = 1500;

export function rankCommands(commands: readonly CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase();
  const byName = commands.filter((c) => subsequence(c.name, q));
  const prefix = byName.filter((c) => c.name.toLowerCase().startsWith(q));
  const rest = byName.filter((c) => !c.name.toLowerCase().startsWith(q));
  // Descriptions are prose: substring, never subsequence, or three letters match everything.
  const byDescription = q.length >= 3 ? commands.filter((c) => !byName.includes(c) && c.description.toLowerCase().includes(q)) : [];
  return [...prefix, ...rest, ...byDescription];
}

const SHORTCUTS: [string, string][] = [
  ["enter", "send · queue while working"],
  ["alt+enter", "newline (or end a line with \\)"],
  ["esc", "interrupt · close menu · twice to clear"],
  ["↑ ↓", "history"],
  ["tab", "accept suggestion"],
  ["@", "mention a file"],
  ["/", "commands"],
  ["shift+tab", "mode: default → accept edits → plan"],
  ["ctrl+t", "thinking level"],
  ["ctrl+o", "expand output"],
  ["ctrl+l", "clear screen"],
  ["ctrl+c", "clear · interrupt · twice to quit"],
];

export function Composer(props: ComposerProps): React.ReactElement {
  const [draft, setDraftState] = useState<ed.Draft>(ed.empty);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [pending, setPending] = useState<"ctrl-c" | "esc" | null>(null);
  const history = useRef<string[]>([]);
  const historyAt = useRef<number | null>(null);
  const stash = useRef("");
  const lastPress = useRef<{ key: string; at: number } | null>(null);

  // The draft lives in a ref as well as in state: several key events can arrive
  // before React re-renders, and each must build on the one before it.
  const draftRef = useRef<ed.Draft>(ed.empty);
  const setDraft = (next: ed.Draft | ((d: ed.Draft) => ed.Draft)) => {
    const d = draftRef.current;
    const v = typeof next === "function" ? next(d) : next;
    draftRef.current = v;
    setDraftState(v);
    if (v.text !== d.text) {
      setMenuClosed(false);
      setMenuIndex(0);
      props.onDraft(v.text);
    }
  };

  useEffect(() => {
    if (props.draftRequest) setDraft({ text: props.draftRequest.text, cursor: props.draftRequest.text.length });
    // Only a new request replaces the draft, never a re-render.
  }, [props.draftRequest?.seq]);

  const token = ed.activeToken(draft);
  const suggestions: Suggestion[] = useMemo(() => {
    if (!token || menuClosed) return [];
    if (token.kind === "slash")
      return rankCommands(props.commands(), token.query).map((c) => ({
        value: `/${c.name}`,
        label: `/${c.name}`,
        detail: c.source === "builtin" ? c.description : `${c.description} · ${c.source}`,
      }));
    return matchFiles(props.files(), token.query, 50).map((f) => ({ value: `@${f}`, label: f }));
  }, [token?.kind, token?.query, menuClosed]);
  const menuOpen = suggestions.length > 0;
  const selected = suggestions[Math.min(menuIndex, suggestions.length - 1)];

  const pressedTwice = (key: string): boolean => {
    const now = Date.now();
    const twice = lastPress.current?.key === key && now - lastPress.current.at < DOUBLE_PRESS_MS;
    lastPress.current = twice ? null : { key, at: now };
    return twice;
  };

  const submit = (text: string, mode: "auto" | "steer" = "auto") => {
    if (!text.trim()) return;
    history.current = [...history.current.filter((h) => h !== text), text].slice(-200);
    historyAt.current = null;
    setDraft(ed.empty);
    props.onSubmit(text, mode);
  };

  const accept = (s: Suggestion, run: boolean) => {
    if (!token) return;
    if (token.kind === "slash") {
      if (run) return submit(s.value);
      return setDraft({ text: `${s.value} `, cursor: s.value.length + 1 });
    }
    setDraft((d) => ed.replaceToken(d, token.from, `${s.value} `));
  };

  const recall = (dir: -1 | 1) => {
    const h = history.current;
    if (h.length === 0) return;
    if (historyAt.current === null) {
      if (dir === 1) return;
      stash.current = draftRef.current.text;
      historyAt.current = h.length - 1;
    } else {
      const next = historyAt.current + dir;
      if (next >= h.length) {
        historyAt.current = null;
        return setDraft({ text: stash.current, cursor: stash.current.length });
      }
      historyAt.current = Math.max(0, next);
    }
    const text = h[historyAt.current]!;
    setDraft({ text, cursor: text.length });
  };

  usePaste(
    (text) => {
      setDraft((d) => ed.insert(d, text.replace(/\r\n?/g, "\n")));
    },
    { isActive: props.active },
  );

  useInput(
    (input, key) => {
      const draft = draftRef.current;
      if (!(key.ctrl && input === "c") && !key.escape) setPending(null);
      if (showShortcuts && !(input === "?" && !draft.text)) setShowShortcuts(false);

      if (key.ctrl && input === "c") {
        if (draft.text) return setDraft(ed.empty);
        if (props.working) return props.onInterrupt();
        if (pressedTwice("ctrl-c")) return props.onQuit();
        return setPending("ctrl-c");
      }
      if (key.ctrl && input === "d") {
        if (!draft.text) props.onQuit();
        return;
      }
      if (key.escape) {
        if (menuOpen) return setMenuClosed(true);
        if (props.working) return props.onInterrupt();
        if (draft.text) {
          if (pressedTwice("esc")) {
            setPending(null);
            return setDraft(ed.empty);
          }
          return setPending("esc");
        }
        return;
      }
      if (key.return) {
        if (key.meta || key.shift) return setDraft((d) => ed.insert(d, "\n"));
        if (draft.text.slice(0, draft.cursor).endsWith("\\"))
          return setDraft((d) => ed.insert(ed.backspace(d), "\n"));
        if (menuOpen && selected) return accept(selected, true);
        return submit(draft.text);
      }
      if (key.tab && key.shift) return props.onCycleMode();
      if (key.tab) {
        if (menuOpen && selected) accept(selected, false);
        else props.onFocusNext?.();
        return;
      }
      if (key.upArrow) {
        if (menuOpen) return setMenuIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        const moved = ed.vertical(draft, -1);
        return moved ? setDraft(moved) : recall(-1);
      }
      if (key.downArrow) {
        if (menuOpen) return setMenuIndex((i) => (i + 1) % suggestions.length);
        const moved = ed.vertical(draft, 1);
        return moved ? setDraft(moved) : recall(1);
      }
      if (key.leftArrow) return setDraft(key.meta || key.ctrl ? ed.wordLeft : ed.left);
      if (key.rightArrow) return setDraft(key.meta || key.ctrl ? ed.wordRight : ed.right);
      if (key.home) return setDraft(ed.home);
      if (key.end) return setDraft(ed.end);
      // Most terminals send DEL for backspace and Ink reports it as `delete`;
      // treating both as backspace is what every Ink app ends up doing.
      if (key.backspace || key.delete) return setDraft(key.meta ? ed.deleteWordBack : ed.backspace);
      if (key.ctrl) {
        switch (input) {
          case "a":
            return setDraft(ed.home);
          case "e":
            return setDraft(ed.end);
          case "u":
            return setDraft(ed.killToStart);
          case "k":
            return setDraft(ed.killToEnd);
          case "w":
            return setDraft(ed.deleteWordBack);
          case "o":
            return props.onToggleExpanded();
          case "l":
            return props.onClear();
          case "t":
            return props.onCycleThinking();
          default:
            return;
        }
      }
      if (key.meta && input === "b") return setDraft(ed.wordLeft);
      if (key.meta && input === "f") return setDraft(ed.wordRight);
      // alt+digit, alt+, and alt+. move between agents: they are not text.
      if (key.meta) return;
      if (input === "?" && !draft.text) return setShowShortcuts((v) => !v);
      if (input) setDraft((d) => ed.insert(d, input));
    },
    { isActive: props.active },
  );

  const lines = draft.text.split("\n");
  let offset = 0;
  const rendered = lines.map((line, i) => {
    const start = offset;
    offset += line.length + 1;
    const hasCursor = draft.cursor >= start && draft.cursor <= start + line.length;
    const prefix = i === 0 ? `${glyph.user} ` : "  ";
    if (!hasCursor || !props.active)
      return (
        <Text key={i}>
          <Text color={color.accent}>{prefix}</Text>
          {line || " "}
        </Text>
      );
    const col = draft.cursor - start;
    return (
      <Text key={i}>
        <Text color={color.accent}>{prefix}</Text>
        {line.slice(0, col)}
        <Text inverse>{line[col] ?? " "}</Text>
        {line.slice(col + 1)}
      </Text>
    );
  });

  const placeholder = props.working ? "Queue a follow-up…  (esc to interrupt)" : "Ask Mnemo anything  ·  / for commands  ·  @ for files";
  const hint =
    pending === "ctrl-c" ? (
      <Text color={color.warning}>press ctrl+c again to quit</Text>
    ) : pending === "esc" ? (
      <Text color={color.warning}>press esc again to clear</Text>
    ) : props.working ? (
      "esc to interrupt · enter to queue"
    ) : (
      "? for shortcuts"
    );

  const start = Math.max(0, Math.min(menuIndex - MENU + 1, suggestions.length - MENU));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderBackgroundColor={ground()} borderColor={props.active ? color.accent : color.subtle} paddingX={1} flexDirection="column">
        {draft.text ? (
          rendered
        ) : (
          <Text color={color.text}>
            <Text color={color.accent}>{`${glyph.user} `}</Text>
            {props.active ? <Text inverse> </Text> : null}
            <Text color={color.subtle}>{placeholder}</Text>
          </Text>
        )}
      </Box>
      {menuOpen ? (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.slice(start, start + MENU).map((s, i) => {
            const on = start + i === menuIndex;
            return (
              <Text key={s.value} wrap="truncate-end">
                <Text color={on ? color.accent : undefined} bold={on}>
                  {s.label.padEnd(22)}
                </Text>
                {s.detail ? <Text color={on ? color.muted : color.subtle}> {s.detail}</Text> : null}
              </Text>
            );
          })}
          {suggestions.length > MENU ? <Text color={color.subtle}>{suggestions.length - MENU} more · keep typing to narrow</Text> : null}
        </Box>
      ) : showShortcuts ? (
        <Box flexDirection="column" paddingX={2}>
          {SHORTCUTS.map(([k, v]) => (
            <Text key={k}>
              <Text color={color.accent}>{k.padEnd(12)}</Text>
              <Text color={color.muted}>{v}</Text>
            </Text>
          ))}
        </Box>
      ) : (
        <Footer data={props.footer} hint={hint} statuses={props.statuses} />
      )}
    </Box>
  );
}
