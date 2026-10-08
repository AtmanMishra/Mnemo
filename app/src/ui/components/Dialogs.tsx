/**
 * The three dialogs every question uses: select, confirm, text. They open in
 * place of the input box, so the conversation above stays visible.
 */
import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import type { Choice, Dialog } from "../../runtime/dialogs.ts";
import { color, glyph } from "../theme.ts";
import * as ed from "../editor.ts";

const WINDOW = 8;

/** Field-by-field substring match, so a query never matches across two fields. */
export function filterChoices(choices: readonly Choice[], query: string): Choice[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...choices];
  return choices.filter((c) => [c.label, c.value, c.description ?? ""].some((f) => f.toLowerCase().includes(q)));
}

function Frame({ tint, title, children, hint }: { tint: string; title: string; children: React.ReactNode; hint: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tint} paddingX={1} marginTop={1}>
      <Text bold color={tint}>
        {title}
      </Text>
      {children}
      <Text color={color.subtle}>{hint}</Text>
    </Box>
  );
}

function SelectDialog({ dialog }: { dialog: Extract<Dialog, { kind: "select" }> }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const items = filterChoices(dialog.choices, query);
  const at = Math.min(index, Math.max(0, items.length - 1));
  useInput((input, key) => {
    if (key.escape) return dialog.resolve(undefined);
    if (key.return) return dialog.resolve(items[at]?.value);
    if (key.upArrow) return setIndex((at - 1 + items.length) % Math.max(1, items.length));
    if (key.downArrow || key.tab) return setIndex((at + 1) % Math.max(1, items.length));
    if (key.pageDown) return setIndex(Math.min(items.length - 1, at + WINDOW));
    if (key.pageUp) return setIndex(Math.max(0, at - WINDOW));
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return setIndex(0);
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setIndex(0);
    }
  });
  const start = Math.max(0, Math.min(at - Math.floor(WINDOW / 2), items.length - WINDOW));
  const visible = items.slice(start, start + WINDOW);
  const labelWidth = Math.min(40, Math.max(8, ...visible.map((c) => c.label.length)));
  return (
    <Frame tint={color.accent} title={dialog.title} hint={`↑↓ move · type to filter · enter choose · esc cancel  ${items.length ? `${at + 1}/${items.length}` : ""}`}>
      <Text>
        <Text color={color.muted}>filter </Text>
        {query ? <Text>{query}</Text> : <Text color={color.subtle}>type to narrow the list</Text>}
      </Text>
      {visible.length === 0 ? <Text color={color.muted}>nothing matches</Text> : null}
      {visible.map((c, i) => {
        const selected = start + i === at;
        return (
          <Text key={c.value} wrap="truncate-end">
            <Text color={color.accent}>{selected ? `${glyph.user} ` : "  "}</Text>
            <Text color={selected ? color.accent : undefined} bold={selected}>
              {c.label.padEnd(labelWidth)}
            </Text>
            {c.description ? <Text color={color.muted}>  {c.description}</Text> : null}
          </Text>
        );
      })}
    </Frame>
  );
}

function ConfirmDialog({ dialog }: { dialog: Extract<Dialog, { kind: "confirm" }> }) {
  const [yes, setYes] = useState(true);
  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") return dialog.resolve(false);
    if (input === "y" || input === "Y") return dialog.resolve(true);
    if (key.return) return dialog.resolve(yes);
    if (key.leftArrow || key.rightArrow || key.tab || key.upArrow || key.downArrow) setYes((v) => !v);
  });
  return (
    <Frame tint={color.warning} title={dialog.title} hint="y yes · n no · ←→ choose · enter confirm · esc no">
      {dialog.message ? <Text>{dialog.message}</Text> : null}
      <Box marginTop={1}>
        <Text inverse={yes} color={yes ? color.success : color.muted}>
          {" Yes "}
        </Text>
        <Text> </Text>
        <Text inverse={!yes} color={!yes ? color.error : color.muted}>
          {" No "}
        </Text>
      </Box>
    </Frame>
  );
}

function TextDialog({ dialog }: { dialog: Extract<Dialog, { kind: "text" }> }) {
  const [draft, setDraft] = useState<ed.Draft>(ed.empty);
  usePaste((text) => setDraft((d) => ed.insert(d, text.replace(/\r?\n/g, ""))));
  useInput((input, key) => {
    if (key.escape) return dialog.resolve(undefined);
    if (key.return) return dialog.resolve(draft.text);
    if (key.leftArrow) return setDraft(ed.left);
    if (key.rightArrow) return setDraft(ed.right);
    if (key.home || (key.ctrl && input === "a")) return setDraft(ed.home);
    if (key.end || (key.ctrl && input === "e")) return setDraft(ed.end);
    if (key.backspace) return setDraft(ed.backspace);
    if (key.delete) return setDraft(ed.del);
    if (key.ctrl && input === "u") return setDraft(ed.killToStart);
    if (input && !key.ctrl && !key.meta) setDraft((d) => ed.insert(d, input));
  });
  const shown = dialog.secret ? "•".repeat(draft.text.length) : draft.text;
  const before = shown.slice(0, draft.cursor);
  const at = shown[draft.cursor] ?? " ";
  const after = shown.slice(draft.cursor + 1);
  return (
    <Frame tint={color.accent} title={dialog.title} hint={`enter submit · esc cancel${dialog.secret ? " · input is hidden" : ""}`}>
      <Text>
        <Text color={color.accent}>{glyph.user} </Text>
        {draft.text ? (
          <>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </>
        ) : (
          <>
            <Text inverse> </Text>
            <Text color={color.subtle}>{dialog.placeholder ?? ""}</Text>
          </>
        )}
      </Text>
    </Frame>
  );
}

export function DialogView({ dialog }: { dialog: Dialog }): React.ReactElement {
  // Keyed by id so a new question never inherits the last one's filter or draft.
  switch (dialog.kind) {
    case "select":
      return <SelectDialog key={dialog.id} dialog={dialog} />;
    case "confirm":
      return <ConfirmDialog key={dialog.id} dialog={dialog} />;
    case "text":
      return <TextDialog key={dialog.id} dialog={dialog} />;
  }
}
