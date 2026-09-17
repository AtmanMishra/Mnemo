/**
 * #8 — `mnemo pr`: the text comes from the commits, and the command refuses
 * more than it acts.
 *
 * git and gh are injected, so this suite spawns no process at all — no shell,
 * no git, no network. That is the only way to test the interesting cases: a
 * diverged remote, an unauthenticated gh, and a PR that already exists are
 * states a test cannot create on a real repository without rewriting one
 * (AGENTS.md, "Test fixtures never spawn a shell").
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  assertSafePushArgs,
  derivePrText,
  deriveReviewBody,
  parseLog,
  runPr,
  type Runner,
} from "../src/pr.ts";

interface Spec {
  branch?: string;
  /** The ref refs/heads/<base> resolves to; false = no main and no master. */
  base?: string | false;
  /** Raw `git log` payload. */
  commits?: string;
  stat?: string;
  /** `git status --porcelain` output. */
  dirty?: string;
  /** `git rev-parse --abbrev-ref --symbolic-full-name @{u}`; false = no upstream. */
  upstream?: string | false;
  /** Is the upstream an ancestor of HEAD? false would mean a force push. */
  ancestor?: boolean;
  auth?: boolean;
  /** `git remote get-url origin`; false = no remote at all. */
  remote?: string | false;
  /** URL of a PR gh already has for this branch. */
  existingPr?: string;
  createUrl?: string;
  createOk?: boolean;
  pushOk?: boolean;
  pushStderr?: string;
  commentOk?: boolean;
}

const R = (stdout: string, ok = true, stderr = "") => ({ ok, code: ok ? 0 : 1, stdout, stderr });

/** One commit in git's `%H%x1f%s%x1f%b%x1e` format. */
function logLine(hash: string, subject: string, body = ""): string {
  return `${hash}\x1f${subject}\x1f${body}\x1e`;
}

function fakeRepo(s: Spec = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const branch = s.branch ?? "feat";
  const base = s.base === undefined ? "main" : s.base;
  const run: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    const line = args.join(" ");
    if (cmd === "git") {
      if (line === "rev-parse --is-inside-work-tree") return R("true\n");
      if (line === "rev-parse --abbrev-ref HEAD") return R(`${branch}\n`);
      if (args[0] === "symbolic-ref") return base ? R("refs/remotes/origin/main\n") : R("", false);
      if (line.startsWith("rev-parse --verify --quiet")) {
        const ref = args[3] ?? "";
        const name = ref.replace(/^refs\/heads\//, "").replace(/\^\{commit\}$/, "");
        return name === base ? R("abc\n") : R("", false);
      }
      if (args[0] === "log") return R(s.commits ?? "");
      if (line === "status --porcelain") return R(s.dirty ?? "");
      if (args[0] === "diff" && args[1] === "--stat") return R(s.stat ?? "");
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return s.upstream ? R(`${s.upstream}\n`) : R("", false);
      }
      if (args[0] === "merge-base") return R("", s.ancestor !== false);
      if (args[0] === "remote") return s.remote === false ? R("", false) : R(`${s.remote ?? "https://github.com/o/r.git"}\n`);
      if (args[0] === "push") return R("", s.pushOk !== false, s.pushStderr ?? "");
      return R("", false, `unexpected git ${line}`);
    }
    if (line === "auth status") return R("", s.auth !== false);
    if (args[0] === "pr" && args[1] === "view") {
      return s.existingPr ? R(JSON.stringify({ url: s.existingPr, state: "OPEN" })) : R("", false);
    }
    if (args[0] === "pr" && args[1] === "create") {
      return R(`${s.createUrl ?? "https://github.com/o/r/pull/7"}\n`, s.createOk !== false);
    }
    if (args[0] === "pr" && args[1] === "comment") return R("", s.commentOk !== false);
    return R("", false, `unexpected gh ${line}`);
  };
  const log: string[] = [];
  const err: string[] = [];
  return {
    calls,
    log,
    err,
    run: (argv: string[] = []) => runPr(argv, {
      cwd: "/repo",
      home: "/home/x",
      env: {},
      log: (l) => log.push(l),
      err: (l) => err.push(l),
      run,
    }),
  };
}

const TWO_COMMITS = logLine("a".repeat(40), "feat: add the widget", "It is small.")
  + logLine("b".repeat(40), "test: cover the widget", "");
const STAT = " src/widget.ts | 12 ++++++------\n 1 file changed, 6 insertions(+), 6 deletions(-)\n";

// --- refusals ---------------------------------------------------------------

test("on the base branch: nothing to open, and gh is never called", async () => {
  const r = fakeRepo({ branch: "main", base: "main", commits: TWO_COMMITS });
  assert.equal(await r.run([]), 1);
  assert.match(r.err.join("\n"), /nothing to open a pull request for/);
  assert.deepEqual(r.calls.filter((c) => c.cmd === "gh"), [], "no PR path is attempted from the base branch");
});

test("no commits ahead of the base: nothing to open, and uncommitted work is named", async () => {
  const r = fakeRepo({ commits: "", dirty: "?? scratch.md\n" });
  assert.equal(await r.run([]), 1);
  assert.match(r.err.join("\n"), /nothing to open a pull request for/);
  assert.match(r.err.join("\n"), /uncommitted changes/, "an empty branch with dirty work says which one it is");
  assert.deepEqual(r.calls.filter((c) => c.cmd === "gh"), []);
});

test("an unauthenticated gh is refused with the fix", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, auth: false });
  assert.equal(await r.run([]), 1);
  assert.match(r.err.join("\n"), /gh auth login/);
  assert.deepEqual(r.calls.filter((c) => c.args[1] === "create"), [], "nothing is opened without auth");
});

test("a detached HEAD is refused", async () => {
  const r = fakeRepo({ branch: "HEAD", commits: TWO_COMMITS });
  assert.equal(await r.run([]), 1);
  assert.match(r.err.join("\n"), /detached/);
});

test("not a git repository is refused", async () => {
  const run: Runner = async () => R("", false, "fatal: not a git repository");
  const log: string[] = [];
  const err: string[] = [];
  const code = await runPr([], { cwd: "/tmp/x", home: "/h", env: {}, log: (l) => log.push(l), err: (l) => err.push(l), run });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /not a git repository/);
});

test("an unknown flag is a usage error", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS });
  assert.equal(await r.run(["--yolo"]), 2);
  assert.match(r.err.join("\n"), /usage: mnemo pr/);
});

test("a --base that is not a ref is refused instead of silently defaulting", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS });
  assert.equal(await r.run(["--base", "release-93"]), 1);
  assert.match(r.err.join("\n"), /--base "release-93" is not a ref/);
  assert.deepEqual(r.calls.filter((c) => c.args[1] === "create"), []);
});

// --- the text is the commits ------------------------------------------------

test("--dry-run prints a title and body taken from the commit log, and calls nothing", async () => {
  // Also with no remote: a dry run reports what the branch says without needing
  // anywhere to open it against.
  const r = fakeRepo({ commits: TWO_COMMITS, stat: STAT, remote: false });
  assert.equal(await r.run(["--dry-run"]), 0);
  const out = r.log.join("\n");
  assert.ok(out.includes("feat: add the widget"), "the title is the commit subject, not a paraphrase");
  assert.ok(out.includes("a".repeat(8)), "every commit's hash is in the body");
  assert.ok(out.includes("test: cover the widget"), "every commit's subject is in the body");
  assert.ok(out.includes("1 file changed"), "the file stat is the real one from git");
  assert.ok(!out.includes("LGTM"), "the command has no opinion and must not offer one");
  assert.deepEqual(r.calls.filter((c) => c.cmd === "gh"), [], "a dry run makes no gh call at all");
  assert.deepEqual(r.calls.filter((c) => c.args[0] === "push"), [], "and touches no remote");
});

test("the PR is opened with that derived text and its URL is printed", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, stat: STAT, upstream: "origin/feat", createUrl: "https://github.com/o/r/pull/12" });
  assert.equal(await r.run([]), 0);
  assert.ok(r.log.join("\n").includes("https://github.com/o/r/pull/12"), "the URL is printed");
  const create = r.calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
  assert.ok(create, "gh pr create was called");
  const log = r.calls.find((c) => c.args[0] === "log");
  assert.ok(log!.args.includes("--reverse"), "the log is read oldest-first, so the branch's first commit can title the PR");
  const title = create!.args[create!.args.indexOf("--title") + 1];
  const body = create!.args[create!.args.indexOf("--body") + 1];
  assert.equal(title, "feat: add the widget");
  assert.ok(body!.includes("test: cover the widget"));
  assert.equal(create!.args[create!.args.indexOf("--base") + 1], "main");
  assert.equal(create!.args[create!.args.indexOf("--head") + 1], "feat");
});

test("an already-open PR is reported, not duplicated", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, upstream: "origin/feat", existingPr: "https://github.com/o/r/pull/9" });
  assert.equal(await r.run([]), 0);
  assert.ok(r.log.join("\n").includes("https://github.com/o/r/pull/9"));
  assert.deepEqual(r.calls.filter((c) => c.args[1] === "create"), [], "a second PR for one branch is how a branch gets two review threads");
});

// --- the push this command is allowed to make -------------------------------

test("a branch with no upstream is pushed once, with --set-upstream and no force", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, upstream: false });
  assert.equal(await r.run([]), 0);
  const push = r.calls.find((c) => c.args[0] === "push");
  assert.deepEqual(push!.args, ["push", "--set-upstream", "origin", "feat"]);
  for (const c of r.calls) {
    assert.equal(assertSafePushArgs(c.args), null, `no call may carry a force flag: ${c.cmd} ${c.args.join(" ")}`);
  }
});

test("a diverged remote is refused, and nothing is ever force-pushed", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, upstream: "origin/feat", ancestor: false });
  assert.equal(await r.run([]), 1);
  assert.match(r.err.join("\n"), /never force-pushes/);
  assert.deepEqual(r.calls.filter((c) => c.args[0] === "push"), [], "the refusal happens before any push");
  assert.deepEqual(r.calls.filter((c) => c.args[1] === "create"), []);
});

test("a rejected push is reported, not forced through", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, upstream: "origin/feat", pushOk: false, pushStderr: "! [rejected] feat -> feat (non-fast-forward)" });
  assert.equal(await r.run([]), 1);
  assert.match(r.err.join("\n"), /will not force/);
  assert.deepEqual(r.calls.filter((c) => c.args[1] === "create"), [], "no PR is opened for a branch that is not on the remote");
});

test("no origin remote is refused before any push or gh call", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, remote: false });
  assert.equal(await r.run([]), 1);
  assert.match(r.err.join("\n"), /no `origin` remote/);
  assert.deepEqual(r.calls.filter((c) => c.cmd === "gh"), [], "there is nothing to open against, so gh is not asked");
  assert.deepEqual(r.calls.filter((c) => c.args[0] === "push"), []);
});

test("--no-push refuses instead of pushing, and names the command to run", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, upstream: false });
  assert.equal(await r.run(["--no-push"]), 1);
  assert.match(r.err.join("\n"), /git push --set-upstream origin feat/);
  assert.deepEqual(r.calls.filter((c) => c.args[0] === "push"), []);
});

// --- the review summary, behind its own flag --------------------------------

test("--review posts one summary comment built from the diff", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, stat: STAT, upstream: "origin/feat", createUrl: "https://github.com/o/r/pull/13" });
  assert.equal(await r.run(["--review"]), 0);
  const comments = r.calls.filter((c) => c.args[0] === "pr" && c.args[1] === "comment");
  assert.equal(comments.length, 1, "exactly one comment");
  const body = comments[0]!.args[comments[0]!.args.indexOf("--body") + 1]!;
  assert.ok(body.includes("Review summary"));
  assert.ok(body.includes("feat: add the widget") && body.includes("test: cover the widget"));
  assert.ok(body.includes("1 file changed"));
  assert.ok(!/LGTM|approv/i.test(body), "a summary is not a review verdict — nothing voted on this");
  assert.ok(r.log.join("\n").includes("https://github.com/o/r/pull/13"));
});

test("without --review, nothing is posted", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, upstream: "origin/feat" });
  assert.equal(await r.run([]), 0);
  assert.deepEqual(r.calls.filter((c) => c.args[1] === "comment"), []);
});

test("--review reports a failed comment instead of claiming success", async () => {
  const r = fakeRepo({ commits: TWO_COMMITS, upstream: "origin/feat", commentOk: false });
  assert.equal(await r.run(["--review"]), 1);
  assert.match(r.err.join("\n"), /could not post the review summary/);
});

// --- the pieces, without a runner -------------------------------------------

test("derivePrText titles the branch with its oldest commit, and cuts rather than paraphrases", () => {
  const commits = [
    { hash: "a".repeat(40), subject: "feat: the reason this branch exists", body: "" },
    { hash: "b".repeat(40), subject: "fix: something small", body: "" },
  ];
  const text = derivePrText({ commits, branch: "feat", base: "main", stat: "" });
  assert.equal(text.title, "feat: the reason this branch exists");
  assert.ok(text.body.includes("feat: the reason this branch exists"));
  assert.ok(text.body.includes("fix: something small"));

  const long = derivePrText({
    commits: [{ hash: "a".repeat(40), subject: "x".repeat(200), body: "" }],
    branch: "f", base: "main", stat: "",
  });
  assert.ok(long.title.length <= 72, "a long subject is cut, never rewritten");
  assert.ok(long.title.endsWith("…"));
});

test("parseLog reads multi-line commit bodies, and survives a quote in one", () => {
  const raw = logLine("c".repeat(40), 'fix: handle "quoted" input', "Line one.\nLine two.");
  const commits = parseLog(raw);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]!.subject, 'fix: handle "quoted" input');
  assert.equal(commits[0]!.body, "Line one.\nLine two.");
  assert.deepEqual(parseLog(""), []);
});

test("deriveReviewBody counts, and never votes", () => {
  const body = deriveReviewBody({
    commits: [{ hash: "a".repeat(40), subject: "feat: x", body: "" }],
    branch: "feat", base: "main", stat: STAT,
  });
  assert.ok(body.includes("`feat` → `main`"));
  assert.ok(body.includes("1 file changed, 6 insertions(+), 6 deletions(-)"));
  assert.ok(/no model reviewed this/i.test(body));
});

test("assertSafePushArgs rejects every way to rewrite the remote", () => {
  assert.equal(assertSafePushArgs(["push", "--set-upstream", "origin", "feat"]), null);
  assert.equal(assertSafePushArgs(["push", "origin", "feat"]), null);
  for (const bad of ["--force", "-f", "--force-with-lease", "--mirror", "--delete", "+feat:feat", "--force-if-includes"]) {
    assert.ok(assertSafePushArgs(["push", bad]), `${bad} must be refused`);
  }
});
