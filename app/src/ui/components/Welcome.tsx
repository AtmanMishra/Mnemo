/**
 * The first thing on screen: the wordmark in the brand gradient, where you are,
 * what model is answering, and the three things worth knowing.
 */
import React from "react";
import { Box, Text } from "ink";
import { color, gradientAt, ground } from "../theme.ts";

export interface WelcomeInfo {
  version: string;
  cwd: string;
  model: string;
  /** Set when no provider is configured yet: the welcome says what to do. */
  needsLogin: boolean;
  columns: number;
}

/** "mnemo" in a two-row half-block face. */
const WORDMARK = ["█▀▄▀█ █▄ █ █▀▀ █▀▄▀█ █▀█", "█ ▀ █ █ ▀█ ██▄ █ ▀ █ █▄█"];

function GradientLine({ text }: { text: string }): React.ReactElement {
  const chars = [...text];
  return (
    <Text>
      {chars.map((ch, i) => (
        <Text key={i} color={gradientAt(i / Math.max(1, chars.length - 1))}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

export function Welcome({ info }: { info: WelcomeInfo }): React.ReactElement {
  const wide = info.columns >= 40;
  return (
    <Box flexDirection="column" borderStyle="round" borderBackgroundColor={ground()} borderColor={color.accent} paddingX={2} paddingY={0}>
      {wide ? (
        <Box flexDirection="row" marginTop={1}>
          <Box flexDirection="column">
            {WORDMARK.map((l, i) => (
              <GradientLine key={i} text={l} />
            ))}
          </Box>
          <Box flexDirection="column" marginLeft={2} justifyContent="flex-end">
            <Text color={color.muted}>v{info.version}</Text>
          </Box>
        </Box>
      ) : (
        <Text>
          <GradientLine text="mnemo" /> <Text color={color.muted}>v{info.version}</Text>
        </Text>
      )}
      <Text color={color.muted} italic>
        memory that works like a brain
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text wrap="truncate-middle">
          <Text color={color.muted}>cwd </Text>
          <Text color={color.accent2}>{info.cwd}</Text>
        </Text>
        <Text>
          <Text color={color.muted}>model </Text>
          {info.needsLogin ? <Text color={color.warning}>none yet — /login to add a provider</Text> : <Text>{info.model}</Text>}
        </Text>
      </Box>
      <Box marginTop={1} marginBottom={1}>
        <Text color={color.muted}>
          <Text color={color.accent}>/</Text> commands · <Text color={color.accent}>@</Text> files ·{" "}
          <Text color={color.accent}>esc</Text> interrupt · <Text color={color.accent}>?</Text> shortcuts
        </Text>
      </Box>
    </Box>
  );
}
