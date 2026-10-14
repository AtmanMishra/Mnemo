/**
 * Memory maintenance: `mnemo memory tidy`. It reports what it would change and
 * changes it only when asked, and nothing it does deletes: a fact is retired
 * (kept as history, never recalled) and a node forgotten the same way.
 *
 *   duplicate    a fact saying what another fact in the same profile says, or a
 *                pitfall recording the same failure as a newer one
 *   stale        a project fact whose every file path no longer exists
 *   distrusted   something marked wrong at least twice more than it helped
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { distrusted, factValue, type MemoryService, type Scope } from "./service.ts";

export interface TidyItem {
  why: "duplicate" | "stale" | "distrusted";
  /** What it is, for a person. */
  what: string;
  detail: string;
  /** How to retire it. */
  target: { scope: Scope; key: string } | { node: number };
}

const WORD = /[a-z0-9]+/g;
const normalize = (s: string) => (s.toLowerCase().match(WORD) ?? []).join(" ");

const jaccard = <T>(a: Set<T>, b: Set<T>): number => {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both || 1);
};

/**
 * Two texts say the same thing: equal once normalized, or nearly all the same
 * words in mostly the same order — "use pnpm, never npm" and "use npm, never
 * pnpm" have the same words and opposite meanings.
 */
export function sameMeaning(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return na.length > 0;
  const ta = na.split(" ");
  const tb = nb.split(" ");
  const wa = new Set(ta);
  const wb = new Set(tb);
  if (wa.size < 3 || wb.size < 3) return false;
  const pairs = (t: string[]) => new Set(t.slice(1).map((w, i) => `${t[i]} ${w}`));
  return jaccard(wa, wb) >= 0.85 && jaccard(pairs(ta), pairs(tb)) >= 0.5;
}

/** Extensions that make a token a file name even without a named folder. */
const FILE_EXT = /\.(?:[cm]?[jt]sx?|json|md|mdx|txt|rst|py|rs|go|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|ya?ml|toml|lock|sh|bash|zsh|ps1|html?|css|scss|sql|proto|xml|ini|cfg|conf|env|gradle|sbt|vue|svelte|lua|ex|exs|erl|dart|scala|tf)$/i;
/** `3.11`, `v18`, `20.x`: a version, not a folder or a file. */
const VERSION = /^v?\d+(?:\.(?:\d+|x))*$/i;

/** Relative file paths a fact mentions (`src/app.ts`, `docs/README.md`); not versions (`3.11/3.12`, `18.x/20.x`). */
export function pathsIn(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s`'"(])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),:;])/g)]
    .map((m) => m[1]!)
    .filter((p) => p.includes("/") && !p.startsWith("/") && !/^https?:/.test(p))
    .filter((p) => {
      const parts = p.split("/").filter((x) => x && x !== "." && x !== "..");
      if (parts.some((x) => VERSION.test(x))) return false;
      return FILE_EXT.test(p) || parts.slice(0, -1).some((x) => /^[A-Za-z_-]+$/.test(x));
    });
}

export async function planTidy(mem: MemoryService, projectId: string, projectRoot: string): Promise<TidyItem[]> {
  const out: TidyItem[] = [];
  for (const scope of ["project", "user"] as const) {
    const facts = (await mem.profile(scope, projectId)).filter((f) => f.key !== "last session");
    const sorted = [...facts].sort((a, b) => a.key.localeCompare(b.key));
    const retired = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      const keep = sorted[i]!;
      if (retired.has(keep.key)) continue;
      for (const other of sorted.slice(i + 1))
        if (!retired.has(other.key) && sameMeaning(keep.value, other.value)) {
          retired.add(other.key);
          out.push({ why: "duplicate", what: `${scope} · ${other.key}`, detail: `says what "${keep.key}" says`, target: { scope, key: other.key } });
        }
    }
    if (scope !== "project") continue;
    for (const f of facts) {
      if (retired.has(f.key)) continue;
      const paths = pathsIn(f.value);
      if (paths.length && paths.every((p) => !fs.existsSync(path.resolve(projectRoot, p))))
        out.push({ why: "stale", what: `project · ${f.key}`, detail: `${paths.join(", ")} no longer exist${paths.length === 1 ? "s" : ""}`, target: { scope, key: f.key } });
    }
  }

  // This project's memory and what belongs to none — never another project's
  // pitfalls, nor another project's profile node.
  const here = await mem.project(projectId);
  const nodes = (await mem.nodes(here)).filter((n) => !(n.label.startsWith("project ") && n.id !== here));
  const gone = new Set<number>();
  // Pitfalls: the newest of each failure stays.
  const pitfalls: { id: number; failure: string }[] = [];
  for (const n of nodes.filter((x) => x.area === "Salience")) {
    const state = await mem.state(n.id);
    if (factValue(state, "fix") === undefined) continue;
    pitfalls.push({ id: n.id, failure: factValue(state, "failure") ?? n.label.replace(/^pain: /, "") });
  }
  pitfalls.sort((a, b) => b.id - a.id);
  for (let i = 0; i < pitfalls.length; i++)
    for (const older of pitfalls.slice(i + 1))
      if (!gone.has(older.id) && !gone.has(pitfalls[i]!.id) && sameMeaning(pitfalls[i]!.failure, older.failure)) {
        gone.add(older.id);
        out.push({ why: "duplicate", what: `pitfall · ${older.failure.slice(0, 70)}`, detail: `a newer record of the same failure is kept`, target: { node: older.id } });
      }
  for (const n of nodes)
    if (!gone.has(n.id) && distrusted(n)) {
      gone.add(n.id);
      out.push({ why: "distrusted", what: `${n.kind.toLowerCase()} · ${n.label.slice(0, 70)}`, detail: `marked wrong ${n.unhelpful}×, helped ${n.useful ?? 0}×`, target: { node: n.id } });
    }
  return out;
}

export async function applyTidy(mem: MemoryService, projectId: string, items: readonly TidyItem[]): Promise<number> {
  let done = 0;
  for (const item of items) {
    const ok = "node" in item.target ? await mem.forgetNode(item.target.node) : await mem.forget(item.target.scope, projectId, item.target.key);
    if (ok) done++;
  }
  return done;
}
