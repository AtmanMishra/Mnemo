/**
 * What the workspace shows, as data: the sidebar's panes and their rows, a
 * preview, and the file tree. Pure — the components draw it, the runtime
 * fills it (`src/runtime/workspace-source.ts`), tests read it.
 */

export const PANES = ["files", "memory", "sessions", "skills", "logs"] as const;
export type Pane = (typeof PANES)[number];

export type Tone = "text" | "accent" | "link" | "memory" | "muted" | "faint" | "ok" | "fail";

export interface Item {
  /** Stable within its pane: a path, a node id, a session file. */
  id: string;
  label: string;
  /** Dimmer text after the label. */
  detail?: string;
  /** Indentation in the tree. */
  depth?: number;
  kind?: "dir" | "file" | "head" | "fact" | "pitfall" | "session" | "skill" | "log";
  /** A directory that is open. */
  open?: boolean;
  tone?: Tone;
  /** A mark before the label: a file the agent changed (✎), one a failing check named (!). */
  badge?: { ch: string; tone: Tone };
  /** A file's size as a share of the largest file listed, 0–1: drawn as a dither bar. */
  weight?: number;
}

export interface PreviewLine {
  text: string;
  tone?: Tone;
  /** Shown in the gutter (a line number). */
  gutter?: string;
}

export interface Preview {
  title: string;
  subtitle?: string;
  lines: PreviewLine[];
  /** What the keys do here, e.g. "r resume · enter insert". */
  hint?: string;
}

/** What the workspace needs from the running app. */
export interface WorkspaceSource {
  /** Every file in the project, relative paths. */
  files(): string[];
  /** A file's size in bytes, when it can be read. */
  fileSize?(rel: string): number | undefined;
  memory(): Promise<Item[]>;
  sessions(): Promise<Item[]>;
  skills(): Item[];
  logs(): Item[];
  preview(pane: Pane, id: string): Promise<Preview | undefined>;
  /** A key on an item: `r` resumes a session, `i` puts `@file` in the composer. */
  act(pane: Pane, id: string, key: string): void;
}

/**
 * The visible rows of a file tree: directories first, then files, each
 * sorted; a directory's children only when it is open. `open` holds the open
 * directories' paths.
 */
export function fileTree(paths: readonly string[], open: ReadonlySet<string>): Item[] {
  interface Node {
    dirs: Map<string, Node>;
    files: string[];
  }
  const root: Node = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let n = root;
    for (const dir of parts.slice(0, -1)) {
      let next = n.dirs.get(dir);
      if (!next) n.dirs.set(dir, (next = { dirs: new Map(), files: [] }));
      n = next;
    }
    n.files.push(parts.at(-1)!);
  }
  const out: Item[] = [];
  const walk = (n: Node, prefix: string, depth: number) => {
    for (const name of [...n.dirs.keys()].sort()) {
      const id = prefix ? `${prefix}/${name}` : name;
      const isOpen = open.has(id);
      const child = n.dirs.get(name)!;
      out.push({ id, label: name, kind: "dir", depth, open: isOpen, detail: String(count(child)) });
      if (isOpen) walk(child, id, depth + 1);
    }
    for (const name of n.files.sort()) out.push({ id: prefix ? `${prefix}/${name}` : name, label: name, kind: "file", depth });
  };
  const count = (n: Node): number => n.files.length + [...n.dirs.values()].reduce((a, d) => a + count(d), 0);
  walk(root, "", 0);
  return out;
}

/** The rows a list of `height` shows so that `selected` stays in view, scrolling by pages. */
export function windowFor(total: number, selected: number, height: number): { start: number; end: number } {
  if (total <= height) return { start: 0, end: total };
  const start = Math.min(Math.max(0, selected - Math.floor(height / 2)), total - height);
  return { start, end: start + height };
}
