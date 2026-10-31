/**
 * The scorecard: is Mnemo getting better at this project? Numbers from the
 * outcome records only (evolve/outcome.ts), the earlier half of the window
 * against the later half, so a trend shows and one bad day does not.
 */
import type { OutcomeRecord } from "./outcome.ts";

export interface Score {
  runs: number;
  /** Runs that changed files. */
  edits: number;
  /** Of the runs that changed files: checked and passed, checked and failed, not checked. */
  passed: number;
  failed: number;
  unchecked: number;
  errors: number;
  stopped: number;
  /** Runs whose prompt corrected the run before. */
  corrections: number;
  refusals: number;
  /** Runs that hit a failure an earlier run of this project already hit. */
  repeatFailures: number;
  escalations: number;
  medianTurns: number;
  medianCost: number;
  cost: number;
  cards: number;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** `history` is every earlier record of the projects, for telling a repeated failure from a new one. */
export function score(records: readonly OutcomeRecord[], history: readonly OutcomeRecord[] = []): Score {
  const seen = new Map<string, Set<string>>();
  const remember = (r: OutcomeRecord) => {
    const s = seen.get(r.project.id) ?? new Set<string>();
    for (const f of r.failures) s.add(f);
    seen.set(r.project.id, s);
  };
  for (const r of history) remember(r);
  let repeatFailures = 0;
  for (const r of records) {
    const before = seen.get(r.project.id);
    if (before && r.failures.some((f) => before.has(f))) repeatFailures++;
    remember(r);
  }
  const count = (v: OutcomeRecord["verdict"]) => records.filter((r) => r.verdict === v).length;
  return {
    runs: records.length,
    edits: records.filter((r) => r.files.length > 0).length,
    passed: count("passed"),
    failed: count("failed"),
    unchecked: count("unchecked"),
    errors: count("error"),
    stopped: count("stopped"),
    corrections: records.filter((r) => r.correction).length,
    refusals: records.reduce((a, r) => a + r.refusals, 0),
    repeatFailures,
    escalations: records.filter((r) => r.escalated).length,
    medianTurns: median(records.map((r) => r.turns)),
    medianCost: median(records.map((r) => r.cost)),
    cost: records.reduce((a, r) => a + r.cost, 0),
    cards: records.filter((r) => r.card).length,
  };
}

const pct = (n: number, d: number) => (d === 0 ? "–" : `${Math.round((100 * n) / d)}%`);
const money = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

interface Row {
  label: string;
  value: (s: Score) => string;
  /** Lower is better; undefined: no better direction. */
  lower?: boolean;
  /** The number the arrow compares. */
  n?: (s: Score) => number | undefined;
}

const ROWS: Row[] = [
  { label: "runs", value: (s) => String(s.runs) },
  { label: "changed files", value: (s) => `${s.edits} (${pct(s.edits, s.runs)})` },
  { label: "checked and passed", value: (s) => pct(s.passed, s.edits), lower: false, n: (s) => (s.edits ? s.passed / s.edits : undefined) },
  { label: "checked and failed", value: (s) => pct(s.failed, s.edits), lower: true, n: (s) => (s.edits ? s.failed / s.edits : undefined) },
  { label: "changed, not checked", value: (s) => pct(s.unchecked, s.edits), lower: true, n: (s) => (s.edits ? s.unchecked / s.edits : undefined) },
  { label: "corrected by you next", value: (s) => pct(s.corrections, s.runs), lower: true, n: (s) => (s.runs ? s.corrections / s.runs : undefined) },
  { label: "repeated a known failure", value: (s) => pct(s.repeatFailures, s.runs), lower: true, n: (s) => (s.runs ? s.repeatFailures / s.runs : undefined) },
  { label: "refused calls per run", value: (s) => (s.runs ? (s.refusals / s.runs).toFixed(2) : "–"), lower: true, n: (s) => (s.runs ? s.refusals / s.runs : undefined) },
  { label: "escalated", value: (s) => pct(s.escalations, s.runs), lower: true, n: (s) => (s.runs ? s.escalations / s.runs : undefined) },
  { label: "model errors, stopped", value: (s) => `${s.errors}, ${s.stopped}` },
  { label: "median turns", value: (s) => (s.runs ? String(s.medianTurns) : "–"), lower: true, n: (s) => (s.runs ? s.medianTurns : undefined) },
  { label: "median cost", value: (s) => (s.runs ? money(s.medianCost) : "–"), lower: true, n: (s) => (s.runs ? s.medianCost : undefined) },
  { label: "total cost", value: (s) => money(s.cost) },
  { label: "task cards made", value: (s) => String(s.cards) },
];

/** Better, worse or the same, by more than a tenth (or by an absolute step for small rates). */
function arrow(row: Row, a: Score, b: Score): string {
  if (row.lower === undefined || !row.n) return "";
  const x = row.n(a);
  const y = row.n(b);
  if (x === undefined || y === undefined) return "";
  const step = Math.max(Math.abs(x) * 0.1, 0.02);
  if (Math.abs(y - x) < step) return "  same";
  return (y < x) === row.lower ? "  better" : "  worse";
}

/**
 * The scorecard as text: one column for the whole window, and when there are
 * at least six runs, the earlier and later halves with which way each moved.
 */
export function renderScorecard(records: readonly OutcomeRecord[], o: { title: string; history?: readonly OutcomeRecord[] }): string {
  if (records.length === 0) return `${o.title}\nno runs recorded yet (they are recorded as you work; mnemo settings set recordOutcomes true turns it on)`;
  const all = score(records, o.history);
  const lines = [o.title, `${records[0]!.at.slice(0, 10)} to ${records.at(-1)!.at.slice(0, 10)}`, ""];
  const width = Math.max(...ROWS.map((r) => r.label.length)) + 2;
  if (records.length < 6) {
    for (const r of ROWS) lines.push(`${r.label.padEnd(width)}${r.value(all)}`);
    lines.push("", "fewer than six runs: no trend yet");
    return lines.join("\n");
  }
  const half = Math.floor(records.length / 2);
  const early = score(records.slice(0, half), o.history);
  const late = score(records.slice(half), [...(o.history ?? []), ...records.slice(0, half)]);
  lines.push(`${"".padEnd(width)}${"all".padEnd(14)}${"earlier".padEnd(14)}${"later".padEnd(14)}`);
  for (const r of ROWS) lines.push(`${r.label.padEnd(width)}${r.value(all).padEnd(14)}${r.value(early).padEnd(14)}${r.value(late).padEnd(14)}${arrow(r, early, late)}`.trimEnd());
  return lines.join("\n");
}
