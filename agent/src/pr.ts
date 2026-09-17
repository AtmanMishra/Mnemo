/**
 * `mnemo pr` — open a pull request for the current branch.
 *
 * The honest, small version of PR automation, and the shape of it is the point:
 *
 * - **The text comes from the commits.** Title and body are derived from
 *   `git log <base>..HEAD`, verbatim — subjects, hashes, bodies, and the real
 *   `git diff --stat`. No model writes a word of it, so the PR cannot claim
 *   work the branch does not contain. An older convention would have let a
 *   model invent a "summary"; a summary of a branch is the one thing the branch
 *   already states for itself.
 * - **It refuses more than it acts.** On the base branch, with no commits ahead
 *   of it, in a detached HEAD, with no `origin`, when `gh` is not
 *   authenticated, or when the remote branch has moved on: each of those is a
 *   refusal with the reason and the fix, never a guess.
 * - **It never rewrites history.** The only write to the remote is
 *   `git push --set-upstream origin <branch>` for a branch that has no upstream
 *   yet; a branch whose remote copy has commits we do not have is a refusal
 *   (`assertSafePushArgs` is the code that keeps that true, not the comment).
 *   No rebase, no amend, no force, no `--mirror`, no delete.
 * - **A review summary is opt-in** (`--review`) and is a *summary*, built from
 *   the same facts: commits and file counts. It does not say "LGTM": this
 *   command has no model and no opinion to offer, and a vote manufactured from
 *   a diff stat would be a lie about who reviewed what.
 */
import { spawn } from "node:child_process";

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export type Tool = "git" | "gh";
export type Runner = (cmd: Tool, args: string[], cwd: string) => Promise<RunResult>;

export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

export interface PrOptions {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  log: (s: string) => void;
  err: (s: string) => void;
  /** Runs git/gh. Injected so tests never spawn a process — and never a shell. */
  run?: Runner;
}

// --- the default runner -----------------------------------------------------

/**
 * Spawn without a shell. `args` is an array precisely so a commit subject with
 * a `"` or a `;` in it reaches git as one argument instead of being re-parsed
 * by a shell — a PR title is attacker-adjacent input the moment it comes from
 * someone else's branch.
 */
function defaultRunner(): Runner {
  const candidates = (cmd: Tool): string[] => (process.platform === "win32" ? [cmd, `${cmd}.exe`] : [cmd]);
  return (cmd, args, cwd) => new Promise((resolve) => {
    const names = candidates(cmd);
    let index = 0;
    const attempt = (): void => {
      const child = spawn(names[index]!, args, { cwd, shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (e: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        // Not installed: try the next name before reporting it missing.
        if (e.code === "ENOENT" && index < names.length - 1) {
          index++;
          attempt();
          return;
        }
        resolve({ ok: false, code: 127, stdout, stderr: `${cmd}: ${e.message}` });
      });
      child.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        resolve({ ok: code === 0, code: code ?? 1, stdout, stderr });
      });
    };
    attempt();
  });
}

// --- parsing git's output ---------------------------------------------------

/** One `git log` line per commit: hash, subject, body, separated by 0x1f/0x1e. */
export function parseLog(raw: string): Commit[] {
  return raw
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [hash = "", subject = "", body = ""] = record.split("\x1f");
      return { hash: hash.trim(), subject: subject.trim(), body: body.trim() };
    })
    .filter((c) => c.hash.length > 0);
}

export const LOG_FORMAT = "%H%x1f%s%x1f%b%x1e";

// --- deriving the text ------------------------------------------------------

const TITLE_LIMIT = 72;

/**
 * The branch's own words. The OLDEST commit is the title: it is the one that
 * says why the branch exists, and every later commit is work inside that
 * decision. A single-commit branch therefore titles itself exactly, and a long
 * subject is cut rather than paraphrased — a paraphrase is us editing someone's
 * description of their own change.
 */
export function deriveTitle(commits: Commit[]): string {
  const first = commits[0];
  if (!first) return "";
  return first.subject.length > TITLE_LIMIT
    ? `${first.subject.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
    : first.subject;
}

export interface PrText {
  title: string;
  body: string;
}

export function derivePrText(o: {
  commits: Commit[];
  branch: string;
  base: string;
  stat: string;
}): PrText {
  const { commits, branch, base, stat } = o;
  const first = commits[0];
  const what = first?.body ? first.body : (first?.subject ?? "");
  const out: string[] = [];
  out.push("## What this does");
  out.push("");
  out.push(what || "(the commits below are the description)");
  out.push("");
  out.push(`## Commits (${commits.length})`);
  out.push("");
  for (const c of commits) {
    out.push(`- \`${c.hash.slice(0, 8)}\` ${c.subject}`);
    for (const line of c.body.split("\n")) {
      if (line.trim()) out.push(`  ${line}`);
    }
  }
  out.push("");
  if (stat.trim()) {
    out.push("## Files changed");
    out.push("");
    out.push("```");
    out.push(stat.trimEnd());
    out.push("```");
    out.push("");
  }
  out.push("---");
  out.push("");
  // Not a transcript of a command: the base may be `origin/main` while this
  // line says `main`, and a "run this" line that differs from what was run
  // would be the one lie in the file.
  out.push(
    `Derived from the commits on \`${branch}\` against \`${base}\` by \`mnemo pr\` — ` +
      `${commits.length} commit${commits.length === 1 ? "" : "s"}, no model wrote this.`,
  );
  return { title: deriveTitle(commits), body: out.join("\n") };
}

/** The opt-in comment: counts and names, no verdict. */
export function deriveReviewBody(o: {
  commits: Commit[];
  branch: string;
  base: string;
  stat: string;
}): string {
  const { commits, branch, base, stat } = o;
  const summary = stat.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const out: string[] = [];
  out.push("## Review summary");
  out.push("");
  out.push(
    `\`${branch}\` → \`${base}\` · ${commits.length} commit${commits.length === 1 ? "" : "s"}` +
      (summary ? ` · ${summary}` : ""),
  );
  out.push("");
  out.push("### Commits");
  out.push("");
  for (const c of commits) out.push(`- \`${c.hash.slice(0, 8)}\` ${c.subject}`);
  out.push("");
  if (stat.trim()) {
    out.push("### Files changed");
    out.push("");
    out.push("```");
    out.push(stat.trimEnd());
    out.push("```");
    out.push("");
  }
  out.push("---");
  out.push("");
  out.push("Facts read from the diff by `mnemo pr --review`. No model reviewed this.");
  return out.join("\n");
}

// --- the push this command is allowed to do ---------------------------------

/**
 * Flags that rewrite or destroy what is on the remote. None of them is ever
 * passed — this function exists so that guarantee is testable code and not a
 * sentence in a doc comment, and so the next person who adds a push has to
 * argue with a function called `assertSafePushArgs` first.
 */
const UNSAFE_PUSH_FLAGS = ["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "-d"];

/** Returns the unsafe argument found, or null when the argv is a plain push. */
export function assertSafePushArgs(args: string[]): string | null {
  for (const a of args) {
    if (UNSAFE_PUSH_FLAGS.includes(a)) return a;
    if (a.startsWith("+")) return a; // a leading + on a refspec is a force push
    if (/^--force=/.test(a)) return a;
  }
  return null;
}

// --- the command ------------------------------------------------------------

function usage(o: PrOptions): void {
  o.err(
    "usage: mnemo pr [--base <ref>] [--draft] [--dry-run] [--review] [--no-push]\n" +
      "  opens a pull request for the current branch, titled and described from its commits\n" +
      "  --base <ref>  the branch to open against (default: origin/HEAD, else main, else master)\n" +
      "  --dry-run     print the title and body; makes no gh call and touches no remote\n" +
      "  --draft       open it as a draft\n" +
      "  --review      after the PR exists, post a review summary derived from the diff\n" +
      "  --no-push     do not push; refuse instead when the branch is not on the remote",
  );
}

/** `mnemo pr [flags]` → the process exit code. 0 done · 1 refused · 2 usage. */
export async function runPr(args: string[], o: PrOptions): Promise<number> {
  const flags = new Set<string>();
  let base = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--base") {
      base = args[++i] ?? "";
      if (!base) { usage(o); return 2; }
      continue;
    }
    if (a.startsWith("--base=")) { base = a.slice("--base=".length); continue; }
    if (["--draft", "--dry-run", "--review", "--no-push"].includes(a)) { flags.add(a); continue; }
    o.err(`pr: unknown argument "${a}"`);
    usage(o);
    return 2;
  }
  const dryRun = flags.has("--dry-run");
  const run = o.run ?? defaultRunner();
  const git = (a: string[]) => run("git", a, o.cwd);
  const gh = (a: string[]) => run("gh", a, o.cwd);

  try {
    const inside = await git(["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
      o.err(`pr: ${o.cwd} is not a git repository — nothing to open a pull request from`);
      return 1;
    }

    const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchRes.stdout.trim();
    if (!branchRes.ok || !branch || branch === "HEAD") {
      o.err("pr: HEAD is detached; check out the branch you want a pull request for");
      return 1;
    }

    // An explicit --base must be a real ref, or a typo would silently fall back
    // to the default branch and open the PR against the wrong one.
    if (base) {
      const baseRes = await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
      if (!baseRes.ok) {
        o.err(`pr: --base "${base}" is not a ref in this repository`);
        return 1;
      }
    }
    const resolvedBase = base || await detectBase(git);
    if (!resolvedBase) {
      o.err(
        "pr: cannot tell which branch to open against (no origin/HEAD, no main, no master). " +
          "Pass --base <ref>.",
      );
      return 1;
    }
    // `origin/main` is the right rev for git; `main` is the right branch name
    // for gh and for a person reading the line. One of each.
    const baseName = resolvedBase.replace(/^origin\//, "");
    if (branch === resolvedBase || branch === baseName) {
      o.err(
        `pr: you are on ${branch} — nothing to open a pull request for. ` +
          `Commit on a branch and run this again (\`git switch -c my-change\`).`,
      );
      return 1;
    }

    // --reverse: git lists newest first, and everything here is oldest-first —
    // the branch's first commit titles it, and its history reads in the order
    // the work happened.
    const logRes = await git(["log", "--reverse", `--format=${LOG_FORMAT}`, `${resolvedBase}..HEAD`]);
    if (!logRes.ok) {
      o.err(`pr: git log ${resolvedBase}..HEAD failed: ${logRes.stderr.trim() || logRes.stdout.trim()}`);
      return 1;
    }
    const commits = parseLog(logRes.stdout);
    if (commits.length === 0) {
      const dirty = (await git(["status", "--porcelain"])).stdout.trim();
      o.err(
        `pr: no commits on ${branch} ahead of ${resolvedBase} — nothing to open a pull request for.` +
          (dirty
            ? ` You have uncommitted changes; commit them first (\`git status\`).`
            : ` Commits on the branch are what the description is derived from.`),
      );
      return 1;
    }

    const statusRes = await git(["status", "--porcelain"]);
    const dirtyCount = statusRes.stdout.split("\n").filter((l) => l.trim()).length;
    if (dirtyCount > 0) {
      o.log(`pr: ${dirtyCount} uncommitted change${dirtyCount === 1 ? "" : "s"} will NOT be in this pull request`);
    }

    const statRes = await git(["diff", "--stat", `${resolvedBase}...HEAD`]);
    const stat = statRes.stdout;
    const text = derivePrText({ commits, branch, base: baseName, stat });

    o.log(`pr: ${branch} → ${baseName} · ${commits.length} commit${commits.length === 1 ? "" : "s"}`);
    o.log(`pr: title: ${text.title}`);
    o.log(`\n${text.body}\n`);

    if (dryRun) {
      o.log("pr: --dry-run — no gh call, nothing pushed, nothing opened");
      return 0;
    }

    // A PR needs a remote to open it against. Saying so here beats letting the
    // push fail with git's wording, which names a refspec and not the cause.
    const remote = await git(["remote", "get-url", "origin"]);
    if (!remote.ok) {
      o.err("pr: no `origin` remote — gh cannot open a pull request without one (`git remote add origin <url>`)");
      return 1;
    }

    const auth = await gh(["auth", "status"]);
    if (!auth.ok) {
      o.err(
        "pr: gh is not authenticated — run `gh auth login` (or set GH_TOKEN), then try again. " +
          `gh said: ${(auth.stderr || auth.stdout).trim().split("\n").slice(0, 3).join(" ")}`,
      );
      return 1;
    }

    // An open PR for this branch is the outcome asked for: report it rather
    // than opening a second one, which is how a branch ends up with two review
    // threads and nobody reading either.
    const existing = await gh(["pr", "view", branch, "--json", "url,state"]);
    if (existing.ok) {
      const url = firstUrl(existing.stdout);
      if (url) {
        o.log(`pr: already open — ${url}`);
        if (flags.has("--review")) return await postReview(gh, o, url, deriveReviewBody({ commits, branch, base: baseName, stat }));
        return 0;
      }
    }

    if (flags.has("--no-push")) {
      const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      if (!upstream.ok) {
        o.err(
          `pr: --no-push, and ${branch} has no upstream. Run ` +
            `\`git push --set-upstream origin ${branch}\` yourself, then try again.`,
        );
        return 1;
      }
    } else {
      const pushed = await pushBranch(git, o, branch);
      if (pushed !== 0) return pushed;
    }

    const createArgs = [
      "pr", "create",
      "--base", baseName,
      "--head", branch,
      "--title", text.title,
      "--body", text.body,
    ];
    if (flags.has("--draft")) createArgs.push("--draft");
    const created = await gh(createArgs);
    if (!created.ok) {
      o.err(`pr: gh pr create failed: ${(created.stderr || created.stdout).trim()}`);
      return 1;
    }
    let url = firstUrl(created.stdout);
    if (!url) {
      const view = await gh(["pr", "view", branch, "--json", "url"]);
      url = firstUrl(view.stdout);
    }
    if (!url) {
      o.err("pr: gh reported success but named no pull request — check `gh pr list`");
      return 1;
    }
    o.log(`pr: opened ${url}`);
    if (flags.has("--review")) {
      return await postReview(gh, o, url, deriveReviewBody({ commits, branch, base: baseName, stat }));
    }
    return 0;
  } catch (e) {
    o.err(`pr: ${(e as Error).message}`);
    return 1;
  }
}

async function detectBase(git: (a: string[]) => Promise<RunResult>): Promise<string | undefined> {
  const head = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head.ok) {
    const ref = head.stdout.trim().replace(/^refs\/remotes\//, "");
    if (ref) return ref;
  }
  for (const candidate of ["main", "master"]) {
    const v = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (v.ok) return candidate;
  }
  return undefined;
}

/**
 * Push the branch as it is, once, without rewriting anything.
 *
 * Two cases only. No upstream: `git push --set-upstream origin <branch>`, which
 * creates the remote branch. Upstream already exists: push only when our HEAD
 * contains it — if the remote has commits we do not have, updating it would
 * need a force push, and that is the one thing this command will not do. It
 * says so and stops instead, because a rewrite discards someone's commits and
 * `mnemo pr` cannot know whose.
 */
async function pushBranch(
  git: (a: string[]) => Promise<RunResult>,
  o: PrOptions,
  branch: string,
): Promise<number> {
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok) {
    const args = ["push", "--set-upstream", "origin", branch];
    // The guard is belt-and-braces: the argv above is a plain push, and the
    // function that says so is tested (see assertSafePushArgs).
    const unsafe = assertSafePushArgs(args);
    if (unsafe) {
      o.err(`pr: refusing to run git push with ${unsafe} (this command never rewrites history)`);
      return 1;
    }
    o.log(`pr: pushing ${branch} (no upstream yet)`);
    const res = await git(args);
    if (!res.ok) {
      o.err(`pr: git push failed: ${(res.stderr || res.stdout).trim()}`);
      return 1;
    }
    return 0;
  }

  const upstreamRef = upstream.stdout.trim();
  const contains = await git(["merge-base", "--is-ancestor", upstreamRef, "HEAD"]);
  if (!contains.ok) {
    o.err(
      `pr: ${upstreamRef} has commits ${branch} does not have. Pushing would rewrite history, ` +
        `and \`mnemo pr\` never force-pushes — pull them in yourself (merge or rebase), then try again.`,
    );
    return 1;
  }
  const args = ["push", "origin", branch];
  const unsafe = assertSafePushArgs(args);
  if (unsafe) {
    o.err(`pr: refusing to run git push with ${unsafe} (this command never rewrites history)`);
    return 1;
  }
  o.log(`pr: pushing ${branch} → ${upstreamRef}`);
  const res = await git(args);
  if (!res.ok) {
    o.err(
      `pr: git push failed: ${(res.stderr || res.stdout).trim()} — ` +
        `this command will not force the branch over the remote's copy`,
    );
    return 1;
  }
  return 0;
}

async function postReview(
  gh: (a: string[]) => Promise<RunResult>,
  o: PrOptions,
  url: string,
  body: string,
): Promise<number> {
  const res = await gh(["pr", "comment", url, "--body", body]);
  if (!res.ok) {
    o.err(`pr: could not post the review summary: ${(res.stderr || res.stdout).trim()}`);
    return 1;
  }
  o.log(`pr: posted the review summary on ${url}`);
  return 0;
}

/** gh prints the URL on a line of its own; take the first http(s) token. */
export function firstUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s"'<>]+/);
  return m?.[0];
}
