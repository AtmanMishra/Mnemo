/**
 * The file tree with what this session did to it: a file the agent edited or
 * wrote is marked ✎ in magenta, a file a failing tool's output names is marked
 * ! in red, and each file carries its size relative to the largest one shown.
 */
import * as path from "node:path";
import type { Block } from "../store.ts";
import type { Item } from "./model.ts";

export function decorateFiles(items: readonly Item[], blocks: readonly Block[], cwd: string, size?: (rel: string) => number | undefined): Item[] {
  const rel = (p: unknown) => (typeof p === "string" && p ? path.relative(cwd, path.resolve(cwd, p)) : "");
  const touched = new Set<string>();
  let failing = "";
  for (const b of blocks) {
    if (b.kind !== "tool") continue;
    if ((b.name === "edit" || b.name === "write") && b.status === "done") touched.add(rel(b.args.path ?? b.args.file_path));
    if (b.status === "error") failing = b.output;
  }
  const files = items.filter((i) => i.kind === "file");
  const sizes = size ? new Map(files.map((f) => [f.id, size(f.id) ?? 0])) : undefined;
  const max = sizes ? Math.max(1, ...sizes.values()) : 1;
  return items.map((i) => {
    if (i.kind !== "file") return i;
    const named = failing && (failing.includes(i.id) || failing.includes(path.basename(i.id)));
    const badge = named ? { ch: "!", tone: "fail" as const } : touched.has(i.id) ? { ch: "✎", tone: "accent" as const } : undefined;
    // Log scale: a 100-line file next to a 10 000-line one still shows.
    const weight = sizes ? Math.log1p(sizes.get(i.id) ?? 0) / Math.log1p(max) : undefined;
    return { ...i, badge, weight };
  });
}
