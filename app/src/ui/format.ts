/**
 * How a tool call is described: its title, the one-line summary of its result,
 * and the lines previewed under it. Pure, so the wording is tested as data.
 */
import * as path from "node:path";
import type { Block } from "./store.ts";

type Tool = Extract<Block, { kind: "tool" }>;

const TITLES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Search",
  find: "Find",
  ls: "List",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function shorten(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Paths are shown relative to the working directory when they are inside it. */
export function displayPath(p: string, cwd: string): string {
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

export function toolTitle(tool: Pick<Tool, "name" | "args">, cwd: string): { name: string; arg: string } {
  const a = tool.args;
  const name = TITLES[tool.name] ?? tool.name.charAt(0).toUpperCase() + tool.name.slice(1);
  let arg: string | undefined;
  switch (tool.name) {
    case "read":
    case "edit":
    case "write":
    case "ls":
      arg = str(a.path) && displayPath(str(a.path)!, cwd);
      break;
    case "bash":
      arg = str(a.command) && shorten(str(a.command)!, 80);
      break;
    case "grep":
    case "find":
      arg = [str(a.pattern), str(a.path) && displayPath(str(a.path)!, cwd)].filter(Boolean).join(" in ");
      break;
    default:
      arg = Object.values(a).map(str).find(Boolean);
      if (arg) arg = shorten(arg, 60);
  }
  return { name, arg: arg ?? "" };
}

function lines(text: string): string[] {
  const t = text.replace(/\s+$/, "");
  return t ? t.split("\n") : [];
}

/** Count `+` and `-` lines in pi's display diff. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (/^\+\s*\d/.test(l)) added++;
    else if (/^-\s*\d/.test(l)) removed++;
  }
  return { added, removed };
}

export function toolSummary(tool: Tool): string {
  if (tool.status === "pending") return "waiting";
  if (tool.status === "running") return tool.output ? `${lines(tool.output).length} lines so far` : "running";
  if (tool.status === "error") return lines(tool.output)[0] ?? "failed";
  const n = lines(tool.output).length;
  const diff = (tool.details as { diff?: string } | undefined)?.diff;
  switch (tool.name) {
    case "edit":
      if (diff) {
        const { added, removed } = diffStat(diff);
        return `+${added} −${removed}`;
      }
      return "edited";
    case "write": {
      const content = str(tool.args.content);
      return content ? `wrote ${lines(content).length} lines` : "written";
    }
    case "read":
      return `${n} line${n === 1 ? "" : "s"}`;
    case "bash":
      return n === 0 ? "no output" : `${n} line${n === 1 ? "" : "s"} of output`;
    case "grep":
    case "find":
    case "ls":
      return n === 0 ? "nothing found" : `${n} result${n === 1 ? "" : "s"}`;
    default:
      return n === 0 ? "done" : `${n} line${n === 1 ? "" : "s"}`;
  }
}

export type BodyLine = { text: string; tone?: "add" | "remove" | "muted" };

/**
 * What is shown under the summary. Reads are not previewed (the file is the
 * user's own); diffs and command output are.
 */
export function toolBody(tool: Tool, expanded: boolean): { lines: BodyLine[]; hidden: number } {
  const max = expanded ? Number.POSITIVE_INFINITY : tool.name === "edit" ? 12 : 6;
  let body: BodyLine[] = [];
  const diff = (tool.details as { diff?: string } | undefined)?.diff;
  if (tool.name === "edit" && diff) {
    body = diff.split("\n").map((text) => ({
      text,
      tone: /^\+\s*\d/.test(text) ? "add" : /^-\s*\d/.test(text) ? "remove" : "muted",
    }));
  } else if (tool.status === "error") {
    body = lines(tool.output)
      .slice(1)
      .map((text) => ({ text }));
  } else if (tool.name !== "read" && tool.name !== "write") {
    body = lines(tool.output).map((text) => ({ text, tone: "muted" as const }));
  }
  if (body.length <= max) return { lines: body, hidden: 0 };
  return { lines: body.slice(0, max), hidden: body.length - max };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** `~` for the home directory, and the middle elided when it is long. */
export function displayCwd(cwd: string, home: string, max = 40): string {
  let p = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (p.length > max) p = `${p.slice(0, 8)}…${p.slice(p.length - (max - 9))}`;
  return p;
}
