/**
 * One transcript block on screen. The vocabulary is in DESIGN.md §4.
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Block } from "../store.ts";
import { color, glyph, palette } from "../theme.ts";
import { formatDuration, toolBody, toolSummary, toolTitle } from "../format.ts";
import { testCounts } from "../activity.ts";
import { MotionContext } from "./motion.ts";
import { Markdown } from "./Markdown.tsx";
import { Pulse } from "./Pulse.tsx";
import { Welcome, type WelcomeInfo } from "./Welcome.tsx";

export interface BlockProps {
  block: Block;
  cwd: string;
  expanded: boolean;
  /** The welcome card's facts; the workspace has a header instead and never shows the card. */
  welcome?: WelcomeInfo;
}

/**
 * A block's first moments: its mark resolves through the dither ramp
 * (░ ▒ ▓, then the mark) over about a fifth of a second.
 */
function useMaterialize(): number {
  const motion = React.useContext(MotionContext);
  const [step, setStep] = useState(motion ? 0 : 3);
  useEffect(() => {
    if (step >= 3) return;
    const t = setTimeout(() => setStep((s) => s + 1), 70);
    return () => clearTimeout(t);
  }, [step]);
  return step;
}

const RAMP = ["░", "▒", "▓"];

function Gutter({ mark, tint, children }: { mark: string; tint: string; children: React.ReactNode }): React.ReactElement {
  const step = useMaterialize();
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Text color={tint}>{step < 3 ? RAMP[step] : mark}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * Each kind of tool as a small coloured tile, so a transcript reads by shape:
 * shell cyan, reading violet, writing magenta, searching and memory amber.
 */
const TILES: [RegExp, string, keyof typeof palette][] = [
  [/^(bash|shell)$/, "$", "cyan"],
  [/^read$/, "◉", "violet"],
  [/^edit$/, "✎", "magenta"],
  [/^write$/, "+", "magenta"],
  [/^(grep|find|ls|glob)$/, "⌕", "amber"],
  [/^ipy/, "λ", "green"],
  [/^(memory_|session_search|create_skill)/, "◈", "amber"],
  [/^(agent|task|subagent)/, "⚇", "cyan"],
];

export function toolTile(name: string): { ch: string; bg: string } {
  const hit = TILES.find(([re]) => re.test(name.toLowerCase()));
  return hit ? { ch: hit[1], bg: palette[hit[2]] } : { ch: "▪", bg: palette.dim };
}

/** One pixel per changed line, in the diff's order: green added, red removed. */
function DiffStrip({ lines }: { lines: { tone?: string }[] }) {
  const changed = lines.filter((l) => l.tone === "add" || l.tone === "remove").slice(0, 48);
  if (changed.length === 0) return null;
  return (
    <Text>
      {"  "}
      {changed.map((l, i) => (
        <Text key={i} color={l.tone === "add" ? palette.green : palette.red}>
          ▀
        </Text>
      ))}
    </Text>
  );
}

/** A test run's results as pixels, one per test: green passed, red failed, grey skipped. */
export function TestHeatmap({ output, width }: { output: string; width: number }) {
  const t = testCounts(output);
  if (!t || t.passed + t.failed + t.skipped === 0) return null;
  const cap = Math.max(10, width) * 2;
  const total = t.passed + t.failed + t.skipped;
  const scale = total > cap ? cap / total : 1;
  // Failures first, and never scaled away to nothing.
  const f = t.failed ? Math.max(1, Math.round(t.failed * scale)) : 0;
  const s = Math.round(t.skipped * scale);
  const p = Math.max(t.passed ? 1 : 0, Math.min(cap - f - s, Math.round(t.passed * scale)));
  const px = [...Array(f).fill(palette.red), ...Array(p).fill(palette.green), ...Array(s).fill(palette.faint)];
  const rows: string[][] = [];
  for (let i = 0; i < px.length; i += width) rows.push(px.slice(i, i + width));
  return (
    <Box flexDirection="column" paddingLeft={4}>
      {rows.map((row, y) => (
        <Text key={y}>
          {row.map((c, x) => (
            <Text key={x} color={c}>
              ▀
            </Text>
          ))}
          {y === 0 ? (
            <Text color={t.failed ? palette.red : palette.green}>{`  ${t.passed} passed${t.failed ? ` · ${t.failed} failed` : ""}${t.skipped ? ` · ${t.skipped} skipped` : ""}${scale < 1 ? " (scaled)" : ""}`}</Text>
          ) : null}
        </Text>
      ))}
    </Box>
  );
}

function ToolView({ block, cwd, expanded }: { block: Extract<Block, { kind: "tool" }>; cwd: string; expanded: boolean }) {
  const { name, arg } = toolTitle(block, cwd);
  const body = toolBody(block, expanded);
  const icon =
    block.status === "done" ? (
      <Text color={color.success}>{glyph.ok}</Text>
    ) : block.status === "error" ? (
      <Text color={color.error}>{glyph.fail}</Text>
    ) : (
      <Pulse mode="tool" width={2} />
    );
  const summary = toolSummary(block);
  const tile = toolTile(block.name);
  const step = useMaterialize();
  const full = block.name === "edit" ? toolBody(block, true).lines : [];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          {step < 3 ? <Text color={tile.bg}>{RAMP[step]}</Text> : icon}
        </Box>
        <Text wrap="truncate-end">
          <Text backgroundColor={tile.bg} color={palette.ground} bold>{` ${tile.ch} `}</Text>
          <Text> </Text>
          <Text bold>{name}</Text>
          {arg ? <Text color={color.muted}>({arg})</Text> : null}
          {block.durationMs !== undefined && block.durationMs >= 1000 ? (
            <Text color={color.subtle}> {formatDuration(block.durationMs)}</Text>
          ) : null}
        </Text>
      </Box>
      <Box flexDirection="row" paddingLeft={2}>
        <Text color={color.subtle}>{`${glyph.result} `}</Text>
        <Text color={block.status === "error" ? color.error : color.muted} wrap="truncate-end">
          {summary}
        </Text>
        <DiffStrip lines={full} />
      </Box>
      {block.name === "bash" && block.status !== "running" && block.status !== "pending" ? <TestHeatmap output={block.output} width={40} /> : null}
      {body.lines.length > 0 ? (
        <Box flexDirection="column" paddingLeft={4}>
          {body.lines.map((l, i) => (
            <Text
              key={i}
              wrap="truncate-end"
              color={l.tone === "add" ? color.success : l.tone === "remove" ? color.error : l.tone === "muted" ? color.muted : undefined}
              backgroundColor={l.tone === "add" ? color.addBg : l.tone === "remove" ? color.removeBg : undefined}
            >
              {l.text || " "}
            </Text>
          ))}
          {body.hidden > 0 ? (
            <Text color={color.subtle}>
              … +{body.hidden} lines <Text color={color.muted}>(ctrl+o to expand)</Text>
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

function ThinkingView({ block, expanded }: { block: Extract<Block, { kind: "thinking" }>; expanded: boolean }) {
  if (!block.done) {
    const last = block.text.trim().split("\n").at(-1) ?? "";
    return (
      <Gutter mark={glyph.thinking} tint={color.accent}>
        <Text>
          <Text color={color.muted} italic>
            Thinking{" "}
          </Text>
          <Pulse mode="think" width={10} />
        </Text>
        {last ? (
          <Text color={color.subtle} italic wrap="truncate-end">
            {last}
          </Text>
        ) : null}
      </Gutter>
    );
  }
  const label = block.durationMs && block.durationMs >= 1000 ? `Thought for ${formatDuration(block.durationMs)}` : "Thought";
  return (
    <Gutter mark={glyph.thinking} tint={color.subtle}>
      <Text color={color.muted} italic>
        {label}
        {expanded ? "" : <Text color={color.subtle}> (ctrl+o to show)</Text>}
      </Text>
      {expanded ? (
        <Text color={color.muted} italic>
          {block.text.trim()}
        </Text>
      ) : null}
    </Gutter>
  );
}

export function BlockView({ block, cwd, expanded, welcome }: BlockProps): React.ReactElement {
  switch (block.kind) {
    case "welcome":
      return welcome ? <Welcome info={welcome} /> : <></>;
    case "user":
      return (
        <Gutter mark={glyph.user} tint={color.accent}>
          <Text bold>{block.text}</Text>
        </Gutter>
      );
    case "assistant":
      return (
        <Gutter mark={glyph.assistant} tint={color.accent}>
          {block.done ? <Markdown text={block.text} /> : <Text>{block.text}</Text>}
        </Gutter>
      );
    case "thinking":
      return <ThinkingView block={block} expanded={expanded} />;
    case "tool":
      return <ToolView block={block} cwd={cwd} expanded={expanded} />;
    case "memory":
      return (
        <Gutter mark={glyph.memory} tint={color.accent}>
          <Text color={color.accent}>{block.title}</Text>
          {block.items.slice(0, 8).map((item, i) => (
            <Box key={i} paddingLeft={2}>
              <Text color={color.muted}>{item}</Text>
            </Box>
          ))}
          {block.items.length > 8 ? <Text color={color.subtle}>{`  … +${block.items.length - 8} more`}</Text> : null}
        </Gutter>
      );
    case "notice": {
      const tint = block.tone === "error" ? color.error : block.tone === "warn" ? color.warning : color.muted;
      return (
        <Gutter mark={glyph.notice} tint={tint}>
          <Text color={tint}>{block.text}</Text>
        </Gutter>
      );
    }
  }
}
