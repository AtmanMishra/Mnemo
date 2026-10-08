import React from "react";
import { Box, Text } from "ink";
import type { Footer as FooterData } from "../../runtime/controller.ts";
import { color } from "../theme.ts";

export function Footer({
  data,
  hint,
  statuses,
}: {
  data: FooterData;
  hint: React.ReactNode;
  statuses: readonly [string, string][];
}): React.ReactElement {
  const pct = data.contextPercent;
  const pctColor = pct === null ? color.muted : pct >= 80 ? color.error : pct >= 50 ? color.warning : color.muted;
  const parts: React.ReactNode[] = [
    <Text key="m" color={color.accent}>
      {data.model}
    </Text>,
  ];
  if (data.thinking) parts.push(<Text key="t">think:{data.thinking}</Text>);
  if (pct !== null)
    parts.push(
      <Text key="c" color={pctColor}>
        {Math.round(pct)}% context
      </Text>,
    );
  if (data.cost > 0) parts.push(<Text key="$">${data.cost.toFixed(2)}</Text>);
  if (data.branch) parts.push(<Text key="b">⎇ {data.branch}</Text>);
  parts.push(
    data.memory ? (
      <Text key="mem" color={color.accent}>
        ◈ {data.memory.nodes}
      </Text>
    ) : (
      <Text key="mem" color={color.subtle}>
        ◈ off
      </Text>
    ),
  );
  const mode =
    data.mode === "accept-edits" ? (
      <Text color={color.success}>⏵⏵ accept edits </Text>
    ) : data.mode === "plan" ? (
      <Text color={color.accent2}>⏸ plan mode </Text>
    ) : data.mode === "yolo" ? (
      <Text color={color.error}>⚠ yolo </Text>
    ) : null;
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Box flexShrink={1}>
        <Text color={color.muted} wrap="truncate-end">
          {mode}
          {mode ? <Text color={color.subtle}>(shift+tab) · </Text> : null}
          {hint}
          {statuses.length > 0 ? <Text color={color.subtle}>{"  " + statuses.map(([, v]) => v).join(" · ")}</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={color.muted}>
          {parts.map((p, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <Text color={color.subtle}> · </Text> : null}
              {p}
            </React.Fragment>
          ))}
        </Text>
      </Box>
    </Box>
  );
}
