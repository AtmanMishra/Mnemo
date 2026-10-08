/**
 * Markdown to Ink elements. `marked` only tokenizes; layout is ours, so wrapping
 * is Ink's (measured in cells, ANSI-aware) and code is never reflowed: a code
 * line too long for the terminal is cut, because a line broken to fit is not
 * the line that was written.
 */
import React from "react";
import { Box, Text } from "ink";
import chalk from "chalk";
import { marked, type Token, type Tokens } from "marked";
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import { color, ground } from "../theme.ts";

let themeReady = false;

/**
 * pi's highlighter (highlight.js + pi's theme). Its output carries its own
 * escape codes, so it is skipped when colour is off (NO_COLOR, a pipe) — Ink
 * would otherwise print the codes as text.
 */
function highlight(code: string, lang?: string): string[] {
  if (chalk.level === 0) return code.split("\n");
  try {
    if (!themeReady) {
      initTheme(undefined, false);
      themeReady = true;
    }
    return highlightCode(code, lang);
  } catch {
    return code.split("\n");
  }
}

function Inline({ tokens }: { tokens?: Token[] }): React.ReactElement {
  return (
    <>
      {(tokens ?? []).map((t, i) => {
        switch (t.type) {
          case "strong":
            return (
              <Text key={i} bold>
                <Inline tokens={(t as Tokens.Strong).tokens} />
              </Text>
            );
          case "em":
            return (
              <Text key={i} italic>
                <Inline tokens={(t as Tokens.Em).tokens} />
              </Text>
            );
          case "del":
            return (
              <Text key={i} strikethrough>
                <Inline tokens={(t as Tokens.Del).tokens} />
              </Text>
            );
          case "codespan":
            return (
              <Text key={i} color={color.accent2}>
                {(t as Tokens.Codespan).text}
              </Text>
            );
          case "link": {
            const l = t as Tokens.Link;
            const label = l.tokens?.length ? <Inline tokens={l.tokens} /> : l.href;
            return (
              <Text key={i} color={color.accent2} underline>
                {label}
                {l.text !== l.href ? <Text color={color.muted}> ({l.href})</Text> : null}
              </Text>
            );
          }
          case "br":
            return <Text key={i}>{"\n"}</Text>;
          case "text": {
            const tt = t as Tokens.Text;
            return tt.tokens ? <Inline key={i} tokens={tt.tokens} /> : <Text key={i}>{unescape(tt.text)}</Text>;
          }
          case "escape":
            return <Text key={i}>{(t as Tokens.Escape).text}</Text>;
          default:
            return <Text key={i}>{unescape((t as { raw?: string }).raw ?? "")}</Text>;
        }
      })}
    </>
  );
}

function unescape(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function CodeBlock({ code, lang }: { code: string; lang?: string }): React.ReactElement {
  const lines = highlight(code.replace(/\n$/, ""), lang || undefined);
  return (
    <Box flexDirection="column" borderStyle="round" borderBackgroundColor={ground()} borderColor={color.subtle} paddingX={1}>
      {lang ? <Text color={color.muted}>{lang}</Text> : null}
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
    </Box>
  );
}

function List({ token, depth }: { token: Tokens.List; depth: number }): React.ReactElement {
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <Box flexDirection="column">
      {token.items.map((item, i) => {
        const marker = item.task ? (item.checked ? "☑" : "☐") : token.ordered ? `${start + i}.` : depth % 2 ? "◦" : "•";
        return (
          <Box key={i} flexDirection="row">
            <Text color={color.accent}>{`${marker} `}</Text>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Blocks tokens={item.tokens} depth={depth + 1} tight />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function Table({ token }: { token: Tokens.Table }): React.ReactElement {
  const cell = (c: Tokens.TableCell) => unescape(c.text);
  const rows = [token.header.map(cell), ...token.rows.map((r) => r.map(cell))];
  const widths = token.header.map((_, col) => Math.min(40, Math.max(...rows.map((r) => (r[col] ?? "").length))));
  const line = (r: string[]) => r.map((c, i) => c.slice(0, widths[i]).padEnd(widths[i]!)).join("  │  ");
  return (
    <Box flexDirection="column">
      <Text bold>{line(rows[0]!)}</Text>
      <Text color={color.subtle}>{widths.map((w) => "─".repeat(w)).join("──┼──")}</Text>
      {rows.slice(1).map((r, i) => (
        <Text key={i} wrap="truncate-end">
          {line(r)}
        </Text>
      ))}
    </Box>
  );
}

function Blocks({ tokens, depth = 0, tight = false }: { tokens: Token[]; depth?: number; tight?: boolean }): React.ReactElement {
  const out: React.ReactElement[] = [];
  tokens.forEach((t, i) => {
    let el: React.ReactElement | null = null;
    switch (t.type) {
      case "space":
        return;
      case "heading": {
        const h = t as Tokens.Heading;
        el = (
          <Text bold color={h.depth <= 2 ? color.accent : undefined} underline={h.depth === 1}>
            <Inline tokens={h.tokens} />
          </Text>
        );
        break;
      }
      case "paragraph":
        el = (
          <Text color={color.text}>
            <Inline tokens={(t as Tokens.Paragraph).tokens} />
          </Text>
        );
        break;
      case "text": {
        const tt = t as Tokens.Text;
        el = <Text color={color.text}>{tt.tokens ? <Inline tokens={tt.tokens} /> : unescape(tt.text)}</Text>;
        break;
      }
      case "code":
        el = <CodeBlock code={(t as Tokens.Code).text} lang={(t as Tokens.Code).lang} />;
        break;
      case "list":
        el = <List token={t as Tokens.List} depth={depth} />;
        break;
      case "blockquote":
        el = (
          <Box borderStyle="bold" borderBackgroundColor={ground()} borderLeft borderTop={false} borderRight={false} borderBottom={false} borderColor={color.subtle} paddingLeft={1}>
            <Box flexDirection="column">
              <Blocks tokens={(t as Tokens.Blockquote).tokens} depth={depth} />
            </Box>
          </Box>
        );
        break;
      case "hr":
        el = <Text color={color.subtle}>{"─".repeat(24)}</Text>;
        break;
      case "table":
        el = <Table token={t as Tokens.Table} />;
        break;
      default:
        el = <Text color={color.text}>{(t as { raw?: string }).raw?.trimEnd() ?? ""}</Text>;
    }
    out.push(
      <Box key={i} marginTop={i > 0 && !tight && out.length > 0 ? 1 : 0} flexDirection="column">
        {el}
      </Box>,
    );
  });
  return <>{out}</>;
}

export function Markdown({ text }: { text: string }): React.ReactElement {
  const tokens = marked.lexer(text, { gfm: true });
  return (
    <Box flexDirection="column">
      <Blocks tokens={tokens} />
    </Box>
  );
}
