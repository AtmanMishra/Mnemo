/**
 * /stats: this session, the last seven days and how the tools fared, from
 * pi's session totals and the daily logs under $MNEMO_HOME/logs.
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface LogRecord {
  ts: string;
  session?: string;
  type: "turn" | "tool";
  tool?: string;
  ok?: boolean;
  cost?: number;
}

const DAY = 86_400_000;
const BARS = "▁▂▃▄▅▆▇█";

export function readLogs(home: string, days: number, now: number): { day: string; records: LogRecord[] }[] {
  const out: { day: string; records: LogRecord[] }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    let records: LogRecord[] = [];
    try {
      records = fs
        .readFileSync(path.join(home, "logs", `${day}.jsonl`), "utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            return l ? [JSON.parse(l) as LogRecord] : [];
          } catch {
            return [];
          }
        });
    } catch {
      /* nothing that day */
    }
    out.push({ day, records });
  }
  return out;
}

export function sparkline(values: number[]): string {
  const max = Math.max(...values);
  return values.map((v) => (max <= 0 || v <= 0 ? " " : BARS[Math.min(BARS.length - 1, Math.floor((v / max) * (BARS.length - 1) + 0.5))])).join("");
}

const money = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());

export interface StatsInput {
  session: { id: string; turns: number; toolCalls: number; input: number; output: number; cacheRead: number; cost: number };
  days: { day: string; records: LogRecord[] }[];
  memory?: { nodes: number; recalled: number };
}

export function statsText(s: StatsInput): string {
  const lines: string[] = [];
  const mine = s.days.flatMap((d) => d.records).filter((r) => r.session === s.session.id);
  const failed = mine.filter((r) => r.type === "tool" && r.ok === false).length;
  lines.push(
    `This session  ${s.session.turns} turn${s.session.turns === 1 ? "" : "s"} · ${s.session.toolCalls} tool call${s.session.toolCalls === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""} · ` +
      `${k(s.session.input)} in / ${k(s.session.output)} out${s.session.cacheRead ? ` (${k(s.session.cacheRead)} cached)` : ""} · ${money(s.session.cost)}`,
  );
  const perDay = s.days.map((d) => d.records.filter((r) => r.type === "turn").reduce((a, r) => a + (r.cost ?? 0), 0));
  const turns = s.days.reduce((a, d) => a + d.records.filter((r) => r.type === "turn").length, 0);
  const sessions = new Set(s.days.flatMap((d) => d.records.map((r) => r.session).filter(Boolean))).size;
  lines.push(`Last 7 days   ${sparkline(perDay)}  ${money(perDay.reduce((a, b) => a + b, 0))} · ${turns} model calls · ${sessions} session${sessions === 1 ? "" : "s"}`);
  const tools = new Map<string, { n: number; failed: number }>();
  for (const r of s.days.flatMap((d) => d.records))
    if (r.type === "tool" && r.tool) {
      const t = tools.get(r.tool) ?? { n: 0, failed: 0 };
      t.n++;
      if (r.ok === false) t.failed++;
      tools.set(r.tool, t);
    }
  if (tools.size)
    lines.push(
      `Tools         ${[...tools]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 6)
        .map(([name, t]) => `${name} ${t.n}${t.failed ? ` (${t.failed} ✗)` : ""}`)
        .join(" · ")}`,
    );
  if (s.memory) lines.push(`Memory        ${s.memory.nodes} nodes · ${s.memory.recalled} recalled this session`);
  return lines.join("\n");
}
