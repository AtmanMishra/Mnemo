/**
 * ctrl+p: switch project. Open agents first, then recent folders, then the
 * folders next to this one; typing filters them, and a typed path that exists
 * can be opened directly.
 *
 *   enter       go to that project's agent, or start one there
 *   ctrl+enter  (or tab) always start a new agent there, in parallel
 */
import React, { useMemo, useState } from "react";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Box, Text, useInput } from "ink";
import { projectCandidates, type FleetSnapshot } from "../runtime/fleet.ts";
import { palette, ground } from "./theme.ts";

const tilde = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

/** Subsequence match on the folder name, substring on the path. */
export function matchProject(cwd: string, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const name = path.basename(cwd).toLowerCase();
  let i = 0;
  for (const ch of name) if (ch === q[i]) i++;
  return i === q.length || cwd.toLowerCase().includes(q);
}

export interface ProjectPickerProps {
  fleet: FleetSnapshot;
  current: string | undefined;
  width: number;
  onPick: (cwd: string, fresh: boolean) => void;
  onCancel: () => void;
}

const SHOWN = 12;

export function ProjectPicker(p: ProjectPickerProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const all = useMemo(() => projectCandidates(p.fleet, p.current), [p.fleet, p.current]);
  const typed = query.includes("/") || query.startsWith("~") ? path.resolve(expand(query)) : undefined;
  const typedOk = typed !== undefined && fs.existsSync(typed) && fs.statSync(typed).isDirectory() && !all.includes(typed);
  const items = [...(typedOk ? [typed!] : []), ...all.filter((c) => matchProject(c, query))];
  const at = Math.min(index, Math.max(0, items.length - 1));
  const start = Math.max(0, Math.min(at - SHOWN + 1, items.length - SHOWN));

  useInput((input, key) => {
    if (key.escape) return p.onCancel();
    if (key.return || key.tab) {
      const pick = items[at];
      if (pick) p.onPick(pick, key.tab || key.ctrl);
      return;
    }
    if (key.upArrow) return setIndex(Math.max(0, at - 1));
    if (key.downArrow) return setIndex(Math.min(items.length - 1, at + 1));
    if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setIndex(0);
    }
  });

  const w = Math.min(p.width - 4, 84);
  const agentsAt = new Map(p.fleet.agents.map((a) => [a.cwd, p.fleet.agents.filter((b) => b.cwd === a.cwd).length]));
  return (
    <Box
      position="absolute"
      marginTop={2}
      marginLeft={Math.max(0, Math.floor((p.width - w) / 2))}
      width={w}
      flexDirection="column"
      borderStyle="round" borderBackgroundColor={ground()}
      borderColor={palette.magenta}
      backgroundColor={palette.panel}
      paddingX={1}
    >
      <Text>
        <Text color={palette.magenta}>▞▚ </Text>
        <Text bold color={palette.text}>
          projects
        </Text>
        <Text color={palette.faint}>{"   enter go · tab new agent · esc close"}</Text>
      </Text>
      <Text>
        <Text color={palette.cyan}>{"› "}</Text>
        <Text color={palette.text}>{query}</Text>
        <Text color={palette.magenta}>▌</Text>
        {!query ? <Text color={palette.faint}>{" type a name, or a path (~/code/app)"}</Text> : null}
      </Text>
      {items.length === 0 ? <Text color={palette.faint}>{"  no folder matches"}</Text> : null}
      {items.slice(start, start + SHOWN).map((cwd, i) => {
        const on = start + i === at;
        const n = agentsAt.get(cwd) ?? 0;
        return (
          <Text key={cwd} backgroundColor={on ? palette.selectBg : undefined}>
            <Text color={on ? palette.magenta : palette.faint}>{on ? "▸ " : "  "}</Text>
            <Text color={n ? palette.magenta : palette.dim}>{n ? "● " : "◇ "}</Text>
            <Text bold={on} color={palette.text}>
              {path.basename(cwd).padEnd(20)}
            </Text>
            <Text color={palette.faint}>{tilde(cwd).slice(0, Math.max(0, w - 32))}</Text>
            <Text color={palette.magenta}>{n ? `  ${n} open` : cwd === typed ? "  open this folder" : ""}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
