/**
 * One transcript block on screen. The vocabulary is in DESIGN.md §4.
 */
import React from "react";
import { Box, Text } from "ink";
import type { Block } from "../store.ts";
import { color, glyph } from "../theme.ts";
import { formatDuration, toolBody, toolSummary, toolTitle } from "../format.ts";
import { Markdown } from "./Markdown.tsx";
import { Spinner } from "./Spinner.tsx";
import { Welcome, type WelcomeInfo } from "./Welcome.tsx";

export interface BlockProps {
  block: Block;
  cwd: string;
  expanded: boolean;
  welcome: WelcomeInfo;
}

function Gutter({ mark, tint, children }: { mark: string; tint: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Text color={tint}>{mark}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
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
      <Spinner />
    );
  const summary = toolSummary(block);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          {icon}
        </Box>
        <Text wrap="truncate-end">
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
      </Box>
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
        <Text color={color.muted} italic>
          Thinking…
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
      return <Welcome info={welcome} />;
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
