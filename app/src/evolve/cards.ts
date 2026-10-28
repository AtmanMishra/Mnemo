/**
 * Task cards: past runs that can be run again and judged without a model.
 *
 * A run becomes a card when its result was checked: it started from a clean
 * git tree, changed files, and the last check after its last change passed.
 * The card keeps what a replay needs: the commit it started from, the prompt,
 * the check command and the folder it ran in, and the test files the run
 * wrote or changed (as they were when the check passed). A replay puts those
 * test files back before it runs the check, so a later attempt is judged by
 * the same tests, not by whatever tests it wrote for itself (the SWE-bench
 * rule). Cards live under the Mnemo home, never in the project, so a cloned
 * repository cannot plant one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { evolveDir, projectSlug, type OutcomeRecord } from "./outcome.ts";

export interface TaskCard {
  v: 1;
  id: string;
  /** When the run that made it ended. */
  at: string;
  project: OutcomeRecord["project"];
  sub: string;
  prompt: string;
  /** The commit the run started from. */
  head: string;
  /** The check that passed, run in `sub`. */
  check: string;
  /** Test files as they were when the check passed; put back before a replay's check. */
  tests: { path: string; content: string }[];
  /** Files the original run changed. */
  files: string[];
  /** The original run's change: a replay of it must pass, or the card is broken. */
  patch: string;
  /** The original run's cost and turns: the bar a replay is compared with. */
  source: { model?: string; turns: number; cost: number; session?: string };
  /** Not the first prompt of its session: it may lean on what was said before. */
  followUp: boolean;
  /**
   * What the first replay found when it tried the card on the starting commit:
   *   ok       the check fails with no change and passes with the original change
   *   trivial  the check passes with no change: it cannot tell an attempt from doing nothing
   *   broken   the check fails even with the original change: it cannot be passed
   */
  validity?: "ok" | "trivial" | "broken";
}

/** A path a test framework would pick up. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rs)$/i;
const MAX_TEST_BYTES = 64 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const MIN_PROMPT = 12;

export function cardsDir(home: string, projectId: string): string {
  return path.join(evolveDir(home), "tasks", projectSlug(projectId));
}

/**
 * The check as a replay can run it: a leading `cd <dir> &&` becomes the folder it runs in
 * (it must be inside the project), and what only hides or trims the exit status goes
 * (`; echo "exit=$?"`, `|| true`, `2>&1 | tail -20`). Undefined when it leaves the project.
 */
export function replayableCheck(command: string, root: string, sub: string): { check: string; sub: string } | undefined {
  let c = command.trim();
  let dir = path.resolve(root, sub);
  for (let m = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/.exec(c); m; m = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/.exec(c)) {
    dir = path.resolve(dir, m[1]!.replace(/^["']|["']$/g, ""));
    c = c.slice(m[0].length);
  }
  c = c
    .replace(/\s*;\s*echo\b[^;&|]*\$\?.*$/s, "")
    .replace(/\s*\|\|\s*(true|:)\s*$/, "")
    .replace(/\s*(2>&1\s*)?\|\s*(tail|head)(\s+-n)?(\s+-?\d+)?\s*$/, "")
    .trim();
  // The check may name the folder by another spelling than the root (macOS's /var for /private/var).
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(root), real(dir));
  if (rel.startsWith("..") || path.isAbsolute(rel) || !c) return undefined;
  return { check: c, sub: rel.split(path.sep).join("/") };
}

/** Why a record cannot be a card, or undefined when it can. */
export function unfitReason(r: OutcomeRecord, patch?: string): string | undefined {
  if (r.verdict !== "passed") return `its result was ${r.verdict}`;
  if (!r.git) return "it was not in a git repository";
  if (!r.git.clean) return "the working tree had changes when it started";
  if (r.correction) return "its prompt corrects an earlier run";
  if (r.prompt.trim().length < MIN_PROMPT) return "its prompt is too short to stand alone";
  const check = r.checks.at(-1)?.command;
  if (!check) return "no check ran";
  if (!replayableCheck(check, r.project.root, r.sub)) return "its check runs outside the project";
  if (!patch?.trim()) return "git shows no change";
  if (patch.length > MAX_PATCH_BYTES) return "its change is too large to keep";
  return undefined;
}

/** A card for a record that qualifies, with its test files read from the project as they are now. */
export function cardFor(r: OutcomeRecord, followUp: boolean, patch?: string): TaskCard | undefined {
  if (unfitReason(r, patch)) return undefined;
  const { check, sub } = replayableCheck(r.checks.at(-1)!.command, r.project.root, r.sub)!;
  const tests: TaskCard["tests"] = [];
  for (const file of r.files.filter((f) => TEST_FILE.test(f))) {
    try {
      const full = path.join(r.project.root, file);
      if (fs.statSync(full).size > MAX_TEST_BYTES) continue;
      tests.push({ path: file, content: fs.readFileSync(full, "utf8") });
    } catch {
      /* deleted since: nothing to put back */
    }
  }
  const stamp = r.at.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return {
    v: 1,
    id: `${stamp}-${Math.random().toString(36).slice(2, 6)}`,
    at: r.at,
    project: r.project,
    sub,
    prompt: r.prompt,
    head: r.git!.head,
    check,
    tests,
    files: r.files,
    patch: patch!,
    source: { model: r.model, turns: r.turns, cost: r.cost, session: r.session },
    followUp,
  };
}

export function writeCard(home: string, card: TaskCard): string {
  const dir = cardsDir(home, card.project.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${card.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** A project's cards, oldest first. */
export function readCards(home: string, projectId: string): TaskCard[] {
  const dir = cardsDir(home, projectId);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: TaskCard[] = [];
  for (const n of names) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as TaskCard;
      if (c?.v === 1 && c.id && c.head && c.check) out.push(c);
    } catch {
      /* damaged: skipped */
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function removeCard(home: string, projectId: string, id: string): boolean {
  const file = path.join(cardsDir(home, projectId), `${path.basename(id)}.json`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

export type Split = "held-in" | "held-out";

/**
 * Older cards are what an improver may look at; the newest share is held out,
 * so a change is also judged on tasks it was not tuned on. With fewer than
 * three cards nothing is held out: there is too little to split.
 */
export function splitOf(cards: readonly TaskCard[], heldOutShare = 0.3): Map<string, Split> {
  const sorted = [...cards].sort((a, b) => a.at.localeCompare(b.at));
  const out = sorted.length < 3 ? 0 : Math.max(1, Math.round(sorted.length * heldOutShare));
  return new Map(sorted.map((c, i) => [c.id, i >= sorted.length - out ? "held-out" : "held-in"]));
}
