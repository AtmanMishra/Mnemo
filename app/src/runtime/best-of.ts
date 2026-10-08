/**
 * Best-of-n: the same task, n times, and the project's own check as judge.
 *
 * Each candidate runs in its own git worktree, started from the working tree
 * as it is now (uncommitted changes to tracked files included). When they are
 * all done, the check runs in each; of those that pass, the smallest change
 * wins and is applied to the working tree. Every candidate's diff is kept
 * under $MNEMO_HOME/best-of/, so nothing a candidate did is lost.
 *
 * Dependency folders the project ignores (node_modules, .venv, venv) are
 * linked into each worktree so the check can run there; they stay out of the
 * diffs. Untracked files the working tree has are not copied.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Run one candidate in `cwd`; resolves to its final answer. */
export type CandidateRunner = (i: number, cwd: string) => Promise<string>;

export interface BestOfOptions {
  n: number;
  /** The working tree (any folder inside a git repository). */
  cwd: string;
  /** A shell command; exit 0 is a pass. */
  check: string;
  run: CandidateRunner;
  /** Where the candidates' diffs are kept. */
  keepDir: string;
  checkTimeoutMs?: number;
}

export interface Candidate {
  i: number;
  answer: string;
  passed: boolean;
  /** Lines added + removed. */
  size: number;
  patch: string;
  checkOutput: string;
  error?: string;
}

export interface BestOfResult {
  candidates: Candidate[];
  winner?: Candidate;
  /** Where the diffs were written. */
  kept: string;
}

const LINKED = ["node_modules", ".venv", "venv"];

function git(cwd: string, args: string[], input?: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

async function sh(cwd: string, command: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  const p = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { ok: code === 0, output: `${out}${err}`.slice(-2000) };
}

function sizeOf(patch: string): number {
  return patch.split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l)).length;
}

export async function bestOf(o: BestOfOptions): Promise<BestOfResult> {
  const root = git(o.cwd, ["rev-parse", "--show-toplevel"]).trim();
  const sub = path.relative(root, path.resolve(o.cwd));
  // The working tree as it is: a commit of the uncommitted changes, or HEAD.
  const base = git(root, ["stash", "create"]).trim() || git(root, ["rev-parse", "HEAD"]).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-best-of-"));
  const linked = LINKED.filter((d) => fs.existsSync(path.join(root, d)));
  const trees: string[] = [];
  /** Per worktree, the folders linked into it (not those the commit already has). */
  const links: string[][] = [];
  try {
    for (let i = 0; i < o.n; i++) {
      const tree = path.join(dir, `candidate-${i + 1}`);
      git(root, ["worktree", "add", "--detach", "--quiet", tree, base]);
      const here = linked.filter((d) => !fs.existsSync(path.join(tree, d)));
      for (const d of here) fs.symlinkSync(path.join(root, d), path.join(tree, d));
      trees.push(tree);
      links.push(here);
    }

    const done = await Promise.all(
      trees.map(async (tree, i) => {
        const cwd = path.join(tree, sub);
        let answer = "";
        let error: string | undefined;
        try {
          answer = await o.run(i, cwd);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        let patch = "";
        try {
          git(tree, ["add", "-A"]);
          // The linked dependency folders are not the candidate's work.
          for (const d of links[i]!) git(tree, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", d]);
          patch = git(tree, ["diff", "--cached", "--binary", base]);
        } catch (e) {
          error ??= e instanceof Error ? e.message : String(e);
        }
        return { i: i + 1, cwd, answer, error, patch };
      }),
    );
    // The checks run one at a time, once every candidate is done: run side by
    // side they race on shared caches and ports and fail for no fault of the change.
    const candidates: Candidate[] = [];
    for (const { cwd, ...c } of done) {
      let check = c.patch ? await sh(cwd, o.check, o.checkTimeoutMs ?? 600_000) : { ok: false, output: "no change" };
      // Once more before a change is rejected: the candidates' own runs can
      // leave shared tool caches half-written (seen with npx), failing the
      // first check after them.
      if (c.patch && !check.ok) check = await sh(cwd, o.check, o.checkTimeoutMs ?? 600_000);
      candidates.push({ ...c, size: sizeOf(c.patch), passed: !c.error && check.ok, checkOutput: check.output });
    }

    fs.mkdirSync(o.keepDir, { recursive: true });
    for (const c of candidates) {
      fs.writeFileSync(path.join(o.keepDir, `candidate-${c.i}.patch`), c.patch);
      fs.writeFileSync(path.join(o.keepDir, `candidate-${c.i}.check.txt`), c.checkOutput);
    }
    const winner = candidates.filter((c) => c.passed).sort((a, b) => a.size - b.size)[0];
    if (winner) git(root, ["apply", "--binary", "--whitespace=nowarn"], winner.patch);
    return { candidates, winner, kept: o.keepDir };
  } finally {
    for (const tree of trees) {
      try {
        git(root, ["worktree", "remove", "--force", tree]);
      } catch {
        /* removed below */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      git(root, ["worktree", "prune"]);
    } catch {
      /* nothing to prune */
    }
  }
}

/** One line per candidate, then the winner's answer. */
export function describeBestOf(r: BestOfResult): string {
  const lines = r.candidates.map(
    (c) =>
      `${c === r.winner ? "▸" : " "} candidate ${c.i}  ${c.passed ? "✓ check passed" : c.error ? `✗ ${c.error.slice(0, 60)}` : c.patch ? "✗ check failed" : "✗ changed nothing"}  ${c.size} lines`,
  );
  lines.push(r.winner ? `applied candidate ${r.winner.i} (the smallest change that passed)` : "no candidate passed the check — nothing applied");
  lines.push(`diffs kept in ${r.kept}`);
  if (r.winner?.answer) lines.push("", r.winner.answer);
  return lines.join("\n");
}
