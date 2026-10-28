/**
 * Replay: run a task card again and judge it with the card's own check.
 *
 * Each attempt starts from the card's commit in a fresh git worktree and runs
 * `mnemo -p` there with a scratch Mnemo home: a copy of your settings, keys,
 * skills and agent profiles, plus a copy of your memory journal in the
 * "memory" arm (none in "no-memory"). Whatever the attempt learns or records
 * stays in the scratch home, so your own memory and scorecard are untouched.
 * When it is done, the card's test files are put back over whatever the
 * attempt did to them, and the check runs. A pass needs a change and a passing
 * check.
 *
 * Before the first attempt at a card, the card itself is tried: the check runs
 * on the untouched commit with the tests put back, and must fail; then with
 * the original run's change applied, and must pass. A card that passes with no
 * change cannot tell a good attempt from doing nothing (trivial); one that
 * fails with the original change cannot be passed (broken). Either is left out
 * of scores.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findMemsrv, journalPath } from "@mnemo/memory";
import { git, LINKED, sh } from "../runtime/best-of.ts";
import { childEnv, configuredKeys } from "../runtime/env.ts";
import { agentDir } from "../runtime/paths.ts";
import { selfCommand } from "../runtime/self.ts";
import { readAllOutcomes, type Verdict } from "./outcome.ts";
import type { TaskCard } from "./cards.ts";

export type Arm = "memory" | "no-memory";

export interface Attempt {
  /** The folder to work in (the card's folder inside the worktree). */
  cwd: string;
  prompt: string;
  /** The scratch Mnemo home. */
  home: string;
  arm: Arm;
  model?: string;
  timeoutMs: number;
}

/** Runs one attempt to its end; the default spawns `mnemo -p`. */
export type AttemptRunner = (a: Attempt, env: Record<string, string>) => Promise<{ code: number | null; output: string }>;

export interface ReplayOptions {
  /** Your Mnemo home: where settings, keys, skills and the journal are copied from. */
  home: string;
  arm: Arm;
  model?: string;
  /** For one attempt; default 15 minutes. */
  timeoutMs?: number;
  checkTimeoutMs?: number;
  /** Where each attempt's diff and check output are kept. */
  keepDir: string;
  run?: AttemptRunner;
  /** Attempt a card known to be trivial or broken anyway. */
  force?: boolean;
}

export interface ReplayResult {
  card: string;
  arm: Arm;
  passed: boolean;
  /** The attempt changed files (test files it touched are not counted). */
  changed: boolean;
  /** Set when this replay tried the card first (see the file comment). */
  validity?: TaskCard["validity"];
  /** From the attempt's own outcome record, when it wrote one. */
  turns?: number;
  cost?: number;
  verdict?: Verdict;
  ms: number;
  error?: string;
  checkOutput: string;
}

/** A scratch home with copies of what shapes an attempt: settings, keys, skills, profiles and (memory arm) the journal. */
export function scratchHome(home: string, arm: Arm): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-replay-home-"));
  fs.chmodSync(dir, 0o700);
  const copy = (rel: string) => {
    const from = path.join(home, rel);
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true, mode: 0o700 });
    fs.cpSync(from, path.join(dir, rel), { recursive: true });
  };
  copy("config.json");
  for (const f of ["auth.json", "models.json", "settings.json"]) copy(path.join("agent", f));
  copy(path.join("agent", "skills"));
  copy(path.join("agent", "agents"));
  if (arm === "memory") {
    const journal = journalPath(home);
    if (fs.existsSync(journal)) {
      fs.mkdirSync(path.join(dir, "memory"), { recursive: true, mode: 0o700 });
      fs.copyFileSync(journal, path.join(dir, "memory", "journal.jsonl"));
    }
  }
  return dir;
}

export const spawnAttempt: AttemptRunner = async (a, env) => {
  const args = [...selfCommand(), "-p", a.prompt, "--cwd", a.cwd, "--no-reflect", ...(a.arm === "no-memory" ? ["--no-memory"] : []), ...(a.model ? ["--model", a.model] : [])];
  const p = Bun.spawn(args, { cwd: a.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), a.timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, output: `${out}${err ? `\n${err}` : ""}`.slice(-4000) };
};

function putTests(tree: string, card: TaskCard): void {
  for (const t of card.tests) {
    const file = path.join(tree, t.path);
    // A card is ours, but its paths still stay inside the worktree.
    if (path.relative(tree, file).startsWith("..")) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, t.content);
  }
}

/** Back to the commit: tracked files reset, new files gone, linked dependency folders kept. */
function reset(tree: string, head: string): void {
  git(tree, ["reset", "--hard", "--quiet", head]);
  git(tree, ["clean", "-fdq", ...LINKED.flatMap((d) => ["-e", d])]);
}

export async function replayCard(card: TaskCard, o: ReplayOptions): Promise<ReplayResult> {
  const started = Date.now();
  const base: ReplayResult = { card: card.id, arm: o.arm, passed: false, changed: false, ms: 0, checkOutput: "" };
  const root = card.project.root;
  try {
    git(root, ["cat-file", "-e", `${card.head}^{commit}`]);
  } catch {
    return { ...base, error: `commit ${card.head.slice(0, 10)} is not in ${root}`, ms: Date.now() - started };
  }
  const env = childEnv(process.env, configuredKeys(agentDir(o.home)));
  const checkTimeout = o.checkTimeoutMs ?? 600_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-replay-"));
  const tree = path.join(dir, "tree");
  let home: string | undefined;
  let worktree = false;
  try {
    git(root, ["worktree", "add", "--detach", "--quiet", tree, card.head]);
    worktree = true;
    const linked = LINKED.filter((d) => fs.existsSync(path.join(root, d)) && !fs.existsSync(path.join(tree, d)));
    for (const d of linked) fs.symlinkSync(path.join(root, d), path.join(tree, d));
    const cwd = path.join(tree, card.sub);

    let validity: TaskCard["validity"];
    if (card.validity === undefined) {
      // With no change, the check must fail; with the original change, it must pass.
      putTests(tree, card);
      const empty = (await sh(cwd, card.check, checkTimeout, env)).ok;
      reset(tree, card.head);
      if (empty) validity = "trivial";
      else {
        git(tree, ["apply", "--binary", "--whitespace=nowarn"], card.patch);
        putTests(tree, card);
        validity = (await sh(cwd, card.check, checkTimeout, env)).ok ? "ok" : "broken";
        reset(tree, card.head);
      }
    }
    const known = validity ?? card.validity;
    if (known !== "ok" && !o.force) {
      const why = known === "trivial" ? "the check passes before any change: the card cannot judge an attempt" : "the check fails even with the original change: the card cannot be passed";
      return { ...base, validity, error: why, ms: Date.now() - started };
    }

    home = scratchHome(o.home, o.arm);
    const memsrv = findMemsrv(o.home);
    const attemptEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      MNEMO_HOME: home,
      MNEMO_MEMORY_JOURNAL: path.join(home, "memory", "journal.jsonl"),
      ...(memsrv ? { MNEMO_MEMSRV: memsrv } : {}),
    };
    let error: string | undefined;
    try {
      const r = await (o.run ?? spawnAttempt)({ cwd, prompt: card.prompt, home, arm: o.arm, model: o.model, timeoutMs: o.timeoutMs ?? 15 * 60_000 }, attemptEnv);
      if (r.code !== 0) error = `the attempt exited with ${r.code ?? "a signal"}: ${r.output.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    git(tree, ["add", "-A"]);
    for (const d of linked) git(tree, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", d]);
    const hidden = new Set(card.tests.map((t) => t.path));
    const changedFiles = git(tree, ["diff", "--cached", "--name-only", card.head]).split("\n").filter(Boolean);
    const patch = git(tree, ["diff", "--cached", "--binary", card.head]);
    const changed = changedFiles.some((f) => !hidden.has(f));
    putTests(tree, card);
    let check = { ok: false, output: "no change" };
    if (changed) {
      check = await sh(cwd, card.check, checkTimeout, env);
      // Once more before a fail, as best-of does: an attempt can leave a cache half-written.
      if (!check.ok) check = await sh(cwd, card.check, checkTimeout, env);
    }
    const record = readAllOutcomes(home).at(-1);
    fs.mkdirSync(o.keepDir, { recursive: true, mode: 0o700 });
    const stem = path.join(o.keepDir, `${card.id}.${o.arm}`);
    fs.writeFileSync(`${stem}.patch`, patch, { mode: 0o600 });
    fs.writeFileSync(`${stem}.check.txt`, check.output, { mode: 0o600 });
    return {
      ...base,
      validity,
      passed: changed && check.ok,
      changed,
      turns: record?.turns,
      cost: record?.cost,
      verdict: record?.verdict,
      error,
      checkOutput: check.output,
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  } finally {
    if (worktree) {
      try {
        git(root, ["worktree", "remove", "--force", tree]);
      } catch {
        /* pruned below */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (home) fs.rmSync(home, { recursive: true, force: true });
    try {
      git(root, ["worktree", "prune"]);
    } catch {
      /* nothing to prune */
    }
  }
}
