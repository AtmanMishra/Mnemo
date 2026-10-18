/** Webview state from protocol events. Pure, so a whole session can be asserted on as data. */
import type { Block, CommandInfo, Dialog, Footer, MemoryView, RosterNode, RpcEvent, SettingDef } from "../protocol";

export interface State {
  ready: boolean;
  version: string;
  cwd: string;
  hasModel: boolean;
  commands: CommandInfo[];
  committed: Block[];
  live: Block[];
  working: { since: number; tokens: number } | null;
  queue: string[];
  footer?: Footer;
  statuses: [string, string][];
  roster: RosterNode[];
  self: number;
  settings: Record<string, unknown>;
  defs?: { groups: string[]; items: SettingDef[] };
  dialog?: Dialog;
  /** A line a failed request or the process reported; cleared by the next event of its kind. */
  problem?: string;
  /** Bumped when committed blocks were replaced, so a view drops what it rendered. */
  resetSeq: number;
  memory?: MemoryView;
}

export const initial = (): State => ({
  ready: false,
  version: "",
  cwd: "",
  hasModel: false,
  commands: [],
  committed: [],
  live: [],
  working: null,
  queue: [],
  statuses: [],
  roster: [],
  self: 0,
  settings: {},
  resetSeq: 0,
});

export function reduce(s: State, e: RpcEvent): State {
  switch (e.type) {
    case "ready":
      return { ...s, ready: true, version: e.version, cwd: e.cwd, hasModel: e.hasModel, commands: e.commands, problem: undefined };
    case "transcript":
      return {
        ...s,
        committed: e.reset ? e.committed : [...s.committed.slice(0, e.from), ...e.committed],
        live: e.live,
        working: e.working,
        queue: e.queue,
        resetSeq: e.reset ? s.resetSeq + 1 : s.resetSeq,
      };
    case "chrome":
      return { ...s, footer: e.footer, statuses: e.statuses };
    case "dialog":
      return { ...s, dialog: e.dialog };
    case "dialogClosed":
      return s.dialog?.id === e.id ? { ...s, dialog: undefined } : s;
    case "roster":
      return { ...s, roster: e.nodes, self: e.self };
    case "settings":
      return { ...s, settings: e.values, defs: e.defs ?? s.defs };
    case "error":
      return { ...s, problem: e.message };
    case "result":
      return e.ok ? s : { ...s, problem: e.error };
  }
}

/** The slash commands whose name starts with what is typed after the `/`, best first. */
export function matchCommands(commands: CommandInfo[], typed: string, max = 8): CommandInfo[] {
  if (!typed.startsWith("/") || /\s/.test(typed)) return [];
  const q = typed.slice(1).toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const has = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, max);
}

/** Roster nodes as a tree, depth first, roots first. */
export function tree(nodes: RosterNode[]): { node: RosterNode; depth: number }[] {
  const out: { node: RosterNode; depth: number }[] = [];
  const kids = (parent: number | undefined) => nodes.filter((n) => n.parent === parent);
  const walk = (n: RosterNode, depth: number) => {
    out.push({ node: n, depth });
    for (const k of kids(n.id)) walk(k, depth + 1);
  };
  for (const r of nodes.filter((n) => n.parent === undefined || !nodes.some((m) => m.id === n.parent))) walk(r, 0);
  return out;
}
