/**
 * The evolve loop's measurement (E0, E1): what a run came to, which runs
 * become task cards, the scorecard, and replaying a card in a worktree with a
 * scratch home, judged by the card's own check with its tests put back.
 *
 * The record tests run real sessions on the scripted model; the replay tests
 * use real git and an injected attempt in place of `mnemo -p`.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { cardFor, readCards, replayableCheck, splitOf, TEST_FILE, unfitReason, writeCard, type TaskCard } from "../src/evolve/cards.ts";
import { evolveCommand } from "../src/evolve/cli.ts";
import { appendOutcome, checkPassed, failureSignature, mutates, isCorrection, outcomesFile, readOutcomes, RunTracker, type OutcomeRecord } from "../src/evolve/outcome.ts";
import { replayCard, scratchHome, type AttemptRunner } from "../src/evolve/replay.ts";
import { renderScorecard, score } from "../src/evolve/scorecard.ts";
import { SettingsStore } from "../src/runtime/settings.ts";
import { MEMSRV, mnemoEnv } from "./helpers.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

function gitIn(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@mnemo", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository with one commit: `value.txt` says 1. */
function repo(files: Record<string, string> = { "value.txt": "1\n" }): string {
  const dir = tmp("mnemo-evolve-repo-");
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  gitIn(dir, "init", "-q");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "init");
  return dir;
}

const PROJECT = { id: "repo:/p", name: "p", root: "/p" };

function rec(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    v: 1,
    at: "2026-10-01T10:00:00.000Z",
    project: PROJECT,
    sub: "",
    prompt: "make value.txt say 42",
    correction: false,
    git: { head: "abc", clean: true },
    turns: 4,
    tools: 3,
    toolErrors: 0,
    refusals: 0,
    cost: 0.01,
    tokens: { input: 100, output: 50 },
    files: ["value.txt"],
    checks: [{ command: "sh tests/run.sh", ok: true }],
    verdict: "passed",
    failures: [],
    escalated: false,
    ms: 1000,
    ...over,
  };
}

// ── the record ───────────────────────────────────────────────────────────────

const finish = (t: RunTracker, stopReason?: string, root = "/p") =>
  t.finish({ project: { ...PROJECT, root }, cwd: root, messages: [{ role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.002 } } }, { role: "user" }, { role: "assistant", usage: { input: 20, output: 7, cost: { total: 0.003 } } }], stopReason, escalated: false });

test("the verdict comes from the checks after the last change", () => {
  const none = new RunTracker("look around", undefined);
  none.call("read", { path: "a.ts" }, true);
  expect(finish(none).verdict).toBe("no-edits");

  const unchecked = new RunTracker("change it", undefined);
  unchecked.call("bash", { command: "npm test" }, true);
  unchecked.call("edit", { path: "a.ts" }, true);
  expect(finish(unchecked).verdict).toBe("unchecked");

  const flaky = new RunTracker("change it", undefined);
  flaky.call("edit", { path: "a.ts" }, true);
  flaky.call("bash", { command: "npm test" }, false, "1 failed");
  flaky.call("bash", { command: "npm test" }, true);
  const r = finish(flaky);
  expect(r.verdict).toBe("passed");
  expect(r.checks).toEqual([{ command: "npm test", ok: false }, { command: "npm test", ok: true }]);

  const failed = new RunTracker("change it", undefined);
  failed.call("edit", { path: "a.ts" }, true);
  failed.call("bash", { command: "cd /p && npm test" }, false, "boom");
  failed.call("bash", { command: "ls" }, true);
  expect(finish(failed).verdict).toBe("failed");

  expect(finish(new RunTracker("x", undefined), "error").verdict).toBe("error");
  expect(finish(new RunTracker("x", undefined), "aborted").verdict).toBe("stopped");
});

test("a record counts turns, cost and tokens from the assistant messages, and paths relative to the project root", () => {
  const t = new RunTracker("change it", { head: "h", clean: true });
  t.call("write", { path: "src/a.ts" }, true);
  t.call("edit", { file_path: "/p/b.ts" }, true);
  t.call("edit", { path: "c.ts" }, false, "no match");
  const r = finish(t);
  expect(r.turns).toBe(2);
  expect(r.cost).toBeCloseTo(0.005);
  expect(r.tokens).toEqual({ input: 30, output: 12 });
  expect(r.files).toEqual(["b.ts", "src/a.ts"]);
  expect(r.toolErrors).toBe(1);
  expect(r.failures).toEqual(["edit:c.ts"]);
});

test("refused calls are counted apart and are not failures or checks", () => {
  const t = new RunTracker("change it", undefined);
  t.call("edit", { path: "a.ts" }, true);
  t.call("bash", { command: "npm test" }, false, "The user declined this call.");
  const r = finish(t);
  expect(r.refusals).toBe(1);
  expect(r.toolErrors).toBe(0);
  expect(r.failures).toEqual([]);
  expect(r.verdict).toBe("unchecked");
});

test("a prompt and a check command are redacted before they are kept", () => {
  const t = new RunTracker("deploy with api_key=sk-abcdef1234567890", undefined);
  t.call("edit", { path: "a.ts" }, true);
  t.call("bash", { command: "API_TOKEN=supersecret123 npm test" }, true);
  const r = finish(t);
  expect(r.prompt).not.toContain("sk-abcdef1234567890");
  expect(r.checks[0]!.command).not.toContain("supersecret123");
});

test("corrections and failure signatures", () => {
  for (const p of ["no, use pnpm", "That's wrong", "actually keep the old name", "undo that", "you broke the build"]) expect(isCorrection(p)).toBe(true);
  for (const p of ["note the new API", "add a test", "nothing changed?", "knowledge base"]) expect(isCorrection(p)).toBe(false);
  expect(failureSignature("bash", { command: "cd /x && npm test -- --watch" })).toBe("bash:npm test");
});

test("records append as private lines, and a damaged line is skipped", () => {
  const home = tmp("mnemo-evolve-home-");
  appendOutcome(home, rec());
  fs.appendFileSync(outcomesFile(home, PROJECT.id), "{not json\n");
  appendOutcome(home, rec({ at: "2026-10-02T10:00:00.000Z" }));
  expect(readOutcomes(home, PROJECT.id).map((r) => r.at)).toEqual(["2026-10-01T10:00:00.000Z", "2026-10-02T10:00:00.000Z"]);
  if (process.platform !== "win32") expect(fs.statSync(outcomesFile(home, PROJECT.id)).mode & 0o777).toBe(0o600);
  // The file name is a hash: no part of the project's path or name.
  expect(path.basename(outcomesFile(home, "repo:/home/someone/secret-project"))).toMatch(/^[0-9a-f]{16}\.jsonl$/);
});

// ── cards ────────────────────────────────────────────────────────────────────

test("only a checked run from a clean tree with a standalone prompt becomes a card", () => {
  const P = "diff --git a/value.txt b/value.txt\n";
  expect(unfitReason(rec(), P)).toBeUndefined();
  expect(unfitReason(rec({ verdict: "unchecked" }), P)).toContain("unchecked");
  expect(unfitReason(rec({ verdict: "failed" }), P)).toContain("failed");
  expect(unfitReason(rec({ git: undefined }), P)).toContain("git");
  expect(unfitReason(rec({ git: { head: "h", clean: false } }), P)).toContain("changes");
  expect(unfitReason(rec({ correction: true, prompt: "no, it should say 42 instead" }), P)).toContain("corrects");
  expect(unfitReason(rec({ prompt: "go on" }), P)).toContain("short");
  expect(unfitReason(rec(), "")).toContain("no change");
  expect(unfitReason(rec(), "x".repeat(2 * 1024 * 1024))).toContain("too large");
  expect(unfitReason(rec({ checks: [{ command: "cd /elsewhere && npm test", ok: true }] }), P)).toContain("outside the project");
});

test("a check is kept as a replay can run it", () => {
  const root = "/p";
  expect(replayableCheck("npm test", root, "")).toEqual({ check: "npm test", sub: "" });
  expect(replayableCheck('cd /p && python3 tools/check.py; echo "exit=$?"', root, "")).toEqual({ check: "python3 tools/check.py", sub: "" });
  expect(replayableCheck("cd /p/web && npm test 2>&1 | tail -20", root, "")).toEqual({ check: "npm test", sub: "web" });
  expect(replayableCheck("cd web && cd src && pytest -q || true", root, "")).toEqual({ check: "pytest -q", sub: "web/src" });
  expect(replayableCheck("cd .. && make test", root, "app")).toEqual({ check: "make test", sub: "" });
  expect(replayableCheck("cd /tmp && npm test", root, "")).toBeUndefined();
  expect(replayableCheck("cd ../.. && npm test", root, "app")).toBeUndefined();
});

test("a check that hides its exit status counts only when its output says it", () => {
  expect(checkPassed("npm test", true)).toBe(true);
  expect(checkPassed("npm test", false)).toBe(false);
  expect(checkPassed('python3 tools/check.py; echo "exit=$?"', true, "1 failed\nexit=1")).toBe(false);
  expect(checkPassed('python3 tools/check.py; echo "exit=$?"', true, "check ok\nexit=0")).toBe(true);
  expect(checkPassed("npm test 2>&1 | tail -5", true, "Tests: 3 passed")).toBeUndefined();
  expect(checkPassed("npm test || true", true, "")).toBeUndefined();
});

test("shell commands that change files count as changes", () => {
  for (const c of ["cat >> a.py <<'EOF'\nx\nEOF", "echo x > a.txt", "sed -i 's/a/b/' f", "python3 - <<'EOF'\nopen('a','w')\nEOF", "mv a b", "git apply p.diff", "cd /p && tee f < x", "printf x >>f"]) expect(mutates(c)).toBe(true);
  for (const c of ["npm test 2>&1", "cat a.py", "ls > /dev/null", "grep -n x f", "python3 tools/check.py; echo \"exit=$?\"", "git status", "npm test > /dev/null 2>&1"]) expect(mutates(c)).toBe(false);
});

test("a card keeps the run's test files as they are when the check passed", () => {
  const root = repo({ "value.txt": "1\n" });
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "tests", "run.sh"), "grep -q 42 value.txt\n");
  fs.writeFileSync(path.join(root, "big_test.py"), "x".repeat(70 * 1024));
  const r = rec({ project: { ...PROJECT, root }, files: ["tests/run.sh", "value.txt", "big_test.py", "gone.test.ts"] });
  const card = cardFor(r, false, "diff --git a/value.txt b/value.txt\n+42\n")!;
  expect(card.tests).toEqual([{ path: "tests/run.sh", content: "grep -q 42 value.txt\n" }]);
  expect(card.check).toBe("sh tests/run.sh");
  expect(card.head).toBe("abc");
  expect(card.patch).toContain("+42");
  expect(cardFor(rec({ verdict: "failed" }), false, "x")).toBeUndefined();
});

test("test files are recognised by the usual conventions", () => {
  for (const f of ["tests/a.py", "test/x.js", "src/__tests__/a.tsx", "a.test.ts", "a.spec.js", "test_money.py", "money_test.go", "lib_test.rs", "spec/x.rb"]) expect(TEST_FILE.test(f)).toBe(true);
  for (const f of ["src/attest.ts", "contest.md", "testing.ts", "src/latest.js"]) expect(TEST_FILE.test(f)).toBe(false);
});

test("the newest share of cards is held out, and nothing is with fewer than three", () => {
  const card = (i: number) => ({ id: `c${i}`, at: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z` }) as TaskCard;
  expect([...splitOf([card(0), card(1)]).values()]).toEqual(["held-in", "held-in"]);
  const ten = Array.from({ length: 10 }, (_, i) => card(9 - i));
  const s = splitOf(ten);
  expect(["c7", "c8", "c9"].map((id) => s.get(id))).toEqual(["held-out", "held-out", "held-out"]);
  expect(s.get("c6")).toBe("held-in");
  expect(splitOf([card(0), card(1), card(2)]).get("c2")).toBe("held-out");
});

// ── the scorecard ────────────────────────────────────────────────────────────

test("a failure counts as repeated only when an earlier run of the same project hit it", () => {
  const s = score(
    [rec({ failures: ["bash:npm test"] }), rec({ failures: ["bash:npm test"] }), rec({ project: { ...PROJECT, id: "other" }, failures: ["bash:npm test"] })],
    [],
  );
  expect(s.repeatFailures).toBe(1);
  expect(score([rec({ failures: ["bash:npm test"] })], [rec({ failures: ["bash:npm test"] })]).repeatFailures).toBe(1);
});

test("the scorecard compares the earlier half with the later half", () => {
  const early = Array.from({ length: 4 }, (_, i) => rec({ at: `2026-10-0${i + 1}T00:00:00Z`, verdict: "failed", checks: [{ command: "npm test", ok: false }], turns: 12, cost: 0.05 }));
  const late = Array.from({ length: 4 }, (_, i) => rec({ at: `2026-10-1${i}T00:00:00Z`, turns: 5, cost: 0.02 }));
  const text = renderScorecard([...early, ...late], { title: "p" });
  expect(text).toMatch(/checked and passed\s+50%\s+0%\s+100%\s+better/);
  expect(text).toMatch(/checked and failed\s+50%\s+100%\s+0%\s+better/);
  expect(text).toMatch(/median turns\s+8.5\s+12\s+5\s+better/);
  expect(renderScorecard(early.slice(0, 2), { title: "p" })).toContain("no trend yet");
  expect(renderScorecard([], { title: "p" })).toContain("no runs recorded");
});

// ── recording real sessions ──────────────────────────────────────────────────

const write = (p: string, content: string) => fauxAssistantMessage([fauxToolCall("write", { path: p, content })], { stopReason: "toolUse" });
const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));

async function session(o: Parameters<typeof mnemoEnv>[0] = {}) {
  const e = await mnemoEnv({ mode: "yolo", ...o });
  cleanup.push(() => e.close());
  return e;
}

test("a session's checked run is recorded and becomes a card with its test file", async () => {
  const cwd = repo({ "value.txt": "1\n" });
  const e = await session({ cwd });
  e.faux.setResponses([write("value.txt", "42\n"), write("tests/run.sh", "grep -q 42 value.txt\n"), bash("sh tests/run.sh && echo check ok"), say("value.txt says 42 and the check passes")]);
  await e.controller.submit("make value.txt say 42 and add a check for it");
  await e.idle();
  const [r] = readOutcomes(e.home, readAllProjectId(e.home));
  expect(r).toBeDefined();
  expect(r!.verdict).toBe("passed");
  expect(r!.git).toEqual({ head: gitIn(cwd, "rev-parse", "HEAD"), clean: true });
  expect(r!.files).toEqual(["tests/run.sh", "value.txt"]);
  expect(r!.turns).toBe(4);
  expect(r!.card).toBeDefined();
  const [card] = readCards(e.home, r!.project.id);
  expect(card!.id).toBe(r!.card!);
  expect(card!.tests).toEqual([{ path: "tests/run.sh", content: "grep -q 42 value.txt\n" }]);
  expect(card!.followUp).toBe(false);

  // A second prompt in the same session is a follow-up; this one checks nothing.
  e.faux.setResponses([write("value.txt", "43\n"), say("now 43")]);
  await e.controller.submit("make value.txt say 43 instead of 42");
  await e.idle();
  const both = readOutcomes(e.home, r!.project.id);
  expect(both.map((x) => x.verdict)).toEqual(["passed", "unchecked"]);
  // The tree had the first run's changes: not clean, so no card even if it had passed.
  expect(both[1]!.git!.clean).toBe(false);
  expect(readCards(e.home, r!.project.id)).toHaveLength(1);
});

test("a run that edits through the shell and hides the check's exit status is still read right", async () => {
  // What a real model did: a here-document edit, then `cd <root> && check; echo "exit=$?"`.
  const cwd = repo({ "value.txt": "1\n" });
  const e = await session({ cwd });
  e.faux.setResponses([
    bash(`cd ${cwd} && cat > value.txt <<'EOF'\n42\nEOF`),
    bash(`mkdir -p tests && printf 'grep -qx 42 value.txt\\n' > tests/run.sh`),
    bash(`cd ${cwd} && sh tests/run.sh; echo "exit=$?"`),
    say("done"),
  ]);
  await e.controller.submit("make value.txt say 42 and add a check script");
  await e.idle();
  const [r] = readOutcomes(e.home, readAllProjectId(e.home));
  expect(r!.files).toEqual(["tests/run.sh", "value.txt"]);
  expect(r!.verdict).toBe("passed");
  const [card] = readCards(e.home, r!.project.id);
  expect(card!.check).toBe("sh tests/run.sh");
  expect(card!.sub).toBe("");
  expect(card!.patch).toContain("+42");
  expect(card!.tests).toEqual([{ path: "tests/run.sh", content: "grep -qx 42 value.txt\n" }]);

  // The same, but the check failed: its output says so although the command exited 0.
  const cwd2 = repo({ "value.txt": "1\n" });
  const e2 = await session({ cwd: cwd2 });
  e2.faux.setResponses([bash(`cat > value.txt <<'EOF'\n7\nEOF`), bash(`grep -qx 42 value.txt && echo check ok; echo "exit=$?"`), say("done")]);
  await e2.controller.submit("make value.txt say 42 and check it");
  await e2.idle();
  const [r2] = readOutcomes(e2.home, readAllProjectId(e2.home));
  expect(r2!.verdict).toBe("failed");
  expect(readCards(e2.home, r2!.project.id)).toHaveLength(0);
});

test("a replay of a card made from a real session passes with a good attempt", async () => {
  const cwd = repo({ "value.txt": "1\n" });
  const e = await session({ cwd });
  e.faux.setResponses([write("value.txt", "42\n"), write("tests/run.sh", "grep -qx 42 value.txt\n"), bash("sh tests/run.sh && echo check ok"), say("done")]);
  await e.controller.submit("make value.txt say 42 and add a check for it");
  await e.idle();
  const id = readAllProjectId(e.home);
  const [card] = readCards(e.home, id);
  // The project moves on; the card still starts from where the run started.
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-qm", "done");
  const keepDir = path.join(e.home, "evolve", "replays", "t");
  const good = await replayCard(card!, { home: e.home, arm: "no-memory", keepDir, run: attempt((dir) => fs.writeFileSync(path.join(dir, "value.txt"), "42\n")) });
  expect(good).toMatchObject({ validity: "ok", passed: true });
  const bad = await replayCard({ ...card!, validity: "ok" }, { home: e.home, arm: "no-memory", keepDir, run: attempt((dir) => fs.writeFileSync(path.join(dir, "value.txt"), "41\n")) });
  expect(bad).toMatchObject({ passed: false, changed: true });
});

/** The one project a test home has records for. */
function readAllProjectId(home: string): string {
  const dir = path.join(home, "evolve", "outcomes");
  const [file] = fs.readdirSync(dir);
  const line = fs.readFileSync(path.join(dir, file!), "utf8").split("\n")[0]!;
  return (JSON.parse(line) as OutcomeRecord).project.id;
}

test.skipIf(!MEMSRV)("a run sent back to verify is recorded once, with both parts", async () => {
  const cwd = repo({ "value.txt": "1\n" });
  const e = await session({ cwd, memory: true, verify: true });
  // A .txt change is documentation to the verify nudge: this one changes code.
  e.faux.setResponses([write("value.js", "export default 42;\n"), say("done"), bash("grep -q 42 value.js && echo check passed"), say("checked")]);
  await e.controller.submit("make value.txt say 42 please");
  await e.idle();
  const records = readOutcomes(e.home, readAllProjectId(e.home));
  expect(records).toHaveLength(1);
  expect(records[0]!.verdict).toBe("passed");
  expect(records[0]!.turns).toBe(4);
});

test("with the setting off nothing is recorded", async () => {
  const settings = new SettingsStore();
  settings.set("recordOutcomes", false);
  const cwd = repo();
  const e = await session({ cwd, settings });
  e.faux.setResponses([write("value.txt", "42\n"), say("done")]);
  await e.controller.submit("make value.txt say 42 please");
  await e.idle();
  expect(fs.existsSync(path.join(e.home, "evolve"))).toBe(false);
});

test("a call plan mode refuses is a refusal in the record", async () => {
  const cwd = repo();
  const e = await session({ cwd, mode: "plan" });
  e.faux.setResponses([write("value.txt", "42\n"), say("I cannot write in plan mode")]);
  await e.controller.submit("make value.txt say 42 please");
  await e.idle();
  const [r] = readOutcomes(e.home, readAllProjectId(e.home));
  expect(r!.refusals).toBe(1);
  expect(r!.toolErrors).toBe(0);
  expect(r!.verdict).toBe("no-edits");
});

// ── replay ───────────────────────────────────────────────────────────────────

/** The change "value.txt says <to>" against a repo's HEAD, as git prints it; the repo is left as it was. */
function goldPatch(root: string, to: string): string {
  const before = fs.readFileSync(path.join(root, "value.txt"), "utf8");
  fs.writeFileSync(path.join(root, "value.txt"), `${to}\n`);
  const patch = gitIn(root, "diff", "--binary") + "\n";
  fs.writeFileSync(path.join(root, "value.txt"), before);
  return patch;
}

/** A project at "value.txt says 1", and a card asking for 42, judged by a hidden test. */
function fixture(value = "1") {
  const root = repo({ "value.txt": `${value}\n` });
  const home = tmp("mnemo-evolve-home-");
  const card: TaskCard = {
    v: 1,
    id: "20261001-100000-abcd",
    at: "2026-10-01T10:00:00.000Z",
    project: { id: `repo:${root}`, name: "fixture", root },
    sub: "",
    prompt: "make value.txt say 42",
    head: gitIn(root, "rev-parse", "HEAD"),
    check: "sh tests/run.sh",
    tests: [{ path: "tests/run.sh", content: "grep -qx 42 value.txt\n" }],
    files: ["value.txt", "tests/run.sh"],
    patch: goldPatch(root, "42"),
    source: { turns: 4, cost: 0.01 },
    followUp: false,
  };
  writeCard(home, card);
  return { root, home, card, keepDir: path.join(home, "evolve", "replays", "t") };
}

const attempt = (act: (cwd: string) => void): AttemptRunner & { calls: { cwd: string; home: string; env: Record<string, string> }[] } => {
  const calls: { cwd: string; home: string; env: Record<string, string> }[] = [];
  const run: AttemptRunner = async (a, env) => {
    calls.push({ cwd: a.cwd, home: a.home, env });
    act(a.cwd);
    return { code: 0, output: "" };
  };
  return Object.assign(run, { calls });
};

test("a good attempt passes; the project's own tree and worktree list are untouched", async () => {
  const f = fixture();
  const run = attempt((cwd) => fs.writeFileSync(path.join(cwd, "value.txt"), "42\n"));
  const r = await replayCard(f.card, { home: f.home, arm: "memory", keepDir: f.keepDir, run });
  expect(r).toMatchObject({ passed: true, changed: true, validity: "ok" });
  expect(run.calls).toHaveLength(1);
  expect(run.calls[0]!.cwd).not.toBe(f.root);
  expect(fs.readFileSync(path.join(f.root, "value.txt"), "utf8")).toBe("1\n");
  expect(gitIn(f.root, "status", "--porcelain")).toBe("");
  expect(gitIn(f.root, "worktree", "list").split("\n")).toHaveLength(1);
  expect(fs.readFileSync(path.join(f.keepDir, `${f.card.id}.memory.patch`), "utf8")).toContain("+42");
});

test("doing nothing fails, and so does rewriting the hidden test to pass", async () => {
  const f = fixture();
  const idle = await replayCard(f.card, { home: f.home, arm: "memory", keepDir: f.keepDir, run: attempt(() => {}) });
  expect(idle).toMatchObject({ passed: false, changed: false });
  const known = { ...f.card, validity: "ok" as const };
  const cheat = await replayCard(known, {
    home: f.home,
    arm: "memory",
    keepDir: f.keepDir,
    run: attempt((cwd) => {
      fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "tests", "run.sh"), "exit 0\n");
    }),
  });
  expect(cheat).toMatchObject({ passed: false, changed: false });
  const cheatAndTouch = await replayCard(known, {
    home: f.home,
    arm: "memory",
    keepDir: f.keepDir,
    run: attempt((cwd) => {
      fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "tests", "run.sh"), "exit 0\n");
      fs.writeFileSync(path.join(cwd, "value.txt"), "7\n");
    }),
  });
  expect(cheatAndTouch).toMatchObject({ passed: false, changed: true });
});

test("a card whose original change fails its own check is broken and not attempted", async () => {
  const f = fixture();
  const run = attempt(() => {});
  const r = await replayCard({ ...f.card, patch: goldPatch(f.root, "41") }, { home: f.home, arm: "memory", keepDir: f.keepDir, run });
  expect(r.validity).toBe("broken");
  expect(run.calls).toHaveLength(0);
  expect(gitIn(f.root, "worktree", "list").split("\n")).toHaveLength(1);
});

test("a card whose check passes before any change is trivial and not attempted", async () => {
  const f = fixture("42");
  const run = attempt(() => {});
  const r = await replayCard(f.card, { home: f.home, arm: "memory", keepDir: f.keepDir, run });
  expect(r.validity).toBe("trivial");
  expect(r.passed).toBe(false);
  expect(run.calls).toHaveLength(0);
  expect(gitIn(f.root, "worktree", "list").split("\n")).toHaveLength(1);
});

test("an attempt runs in a scratch home: settings and skills copied, memory only in the memory arm, nothing written back", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, "config.json"), '{"mode":"accept-edits"}');
  fs.mkdirSync(path.join(f.home, "agent", "skills", "release"), { recursive: true });
  fs.writeFileSync(path.join(f.home, "agent", "skills", "release", "SKILL.md"), "# release");
  fs.writeFileSync(path.join(f.home, "agent", "auth.json"), "{}");
  fs.mkdirSync(path.join(f.home, "memory"), { recursive: true });
  fs.writeFileSync(path.join(f.home, "memory", "journal.jsonl"), '{"op":1}\n');
  const seen: Record<string, boolean>[] = [];
  const run: AttemptRunner = async (a, env) => {
    expect(env.MNEMO_HOME).toBe(a.home);
    expect(a.home).not.toBe(f.home);
    expect(env.MNEMO_MEMORY_JOURNAL).toBe(path.join(a.home, "memory", "journal.jsonl"));
    seen.push({
      config: fs.existsSync(path.join(a.home, "config.json")),
      skill: fs.existsSync(path.join(a.home, "agent", "skills", "release", "SKILL.md")),
      auth: fs.existsSync(path.join(a.home, "agent", "auth.json")),
      journal: fs.existsSync(path.join(a.home, "memory", "journal.jsonl")),
    });
    // What the attempt learns stays in the scratch home.
    fs.appendFileSync(path.join(a.home, "memory", "journal.jsonl"), '{"op":2}\n', { flag: "a" });
    fs.writeFileSync(path.join(a.cwd, "value.txt"), "42\n");
    return { code: 0, output: "" };
  };
  await replayCard(f.card, { home: f.home, arm: "memory", keepDir: f.keepDir, run });
  fs.mkdirSync(path.join(f.home, "x"), { recursive: true });
  await replayCard({ ...f.card, validity: "ok" as const }, { home: f.home, arm: "no-memory", keepDir: f.keepDir, run: async (a, env) => {
    // No journal copied: the attempt starts with no memory (and runs with --no-memory).
    seen.push({ journal: fs.existsSync(path.join(a.home, "memory", "journal.jsonl")) });
    return run(a, env);
  } });
  expect(seen[0]).toEqual({ config: true, skill: true, auth: true, journal: true });
  expect(seen[1]).toEqual({ journal: false });
  expect(fs.readFileSync(path.join(f.home, "memory", "journal.jsonl"), "utf8")).toBe('{"op":1}\n');
  // Scratch homes are gone.
  expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("mnemo-replay-home-")).some((n) => fs.existsSync(path.join(os.tmpdir(), n, "memory", "journal.jsonl")) && fs.readFileSync(path.join(os.tmpdir(), n, "memory", "journal.jsonl"), "utf8").includes('"op":2'))).toBe(false);
});

test("an attempt's own outcome record supplies its turns and cost", async () => {
  const f = fixture();
  const run: AttemptRunner = async (a) => {
    fs.writeFileSync(path.join(a.cwd, "value.txt"), "42\n");
    appendOutcome(a.home, rec({ project: f.card.project, turns: 7, cost: 0.0123 }));
    return { code: 0, output: "" };
  };
  const r = await replayCard({ ...f.card, validity: "ok" as const }, { home: f.home, arm: "memory", keepDir: f.keepDir, run });
  expect(r).toMatchObject({ passed: true, turns: 7, cost: 0.0123, verdict: "passed" });
});

test("a failed attempt process and a missing commit are reported, not thrown", async () => {
  const f = fixture();
  const r = await replayCard({ ...f.card, validity: "ok" as const }, { home: f.home, arm: "memory", keepDir: f.keepDir, run: async () => ({ code: 3, output: "mnemo: no model\n" }) });
  expect(r.error).toContain("exited with 3");
  expect(r.error).toContain("no model");
  const gone = await replayCard({ ...f.card, head: "0".repeat(40) }, { home: f.home, arm: "memory", keepDir: f.keepDir, run: attempt(() => {}) });
  expect(gone.error).toContain("is not in");
  expect(gitIn(f.root, "worktree", "list").split("\n")).toHaveLength(1);
});

test("a card's test paths cannot reach outside the worktree", async () => {
  const f = fixture();
  const outside = path.join(path.dirname(f.root), `escape-${path.basename(f.root)}.txt`);
  cleanup.push(() => fs.rmSync(outside, { force: true }));
  const evil = { ...f.card, tests: [...f.card.tests, { path: `../../${path.basename(outside)}`, content: "x" }] };
  await replayCard(evil, { home: f.home, arm: "memory", keepDir: f.keepDir, run: attempt((cwd) => fs.writeFileSync(path.join(cwd, "value.txt"), "42\n")) });
  expect(fs.existsSync(outside)).toBe(false);
});

test("scratchHome copies only what shapes an attempt", () => {
  const home = tmp("mnemo-evolve-home-");
  fs.mkdirSync(path.join(home, "agent", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, "agent", "sessions", "s.jsonl"), "{}");
  fs.writeFileSync(path.join(home, "agent", "models.json"), "{}");
  fs.mkdirSync(path.join(home, "evolve", "outcomes"), { recursive: true });
  fs.writeFileSync(path.join(home, "evolve", "outcomes", "x.jsonl"), "{}");
  const s = scratchHome(home, "memory");
  cleanup.push(() => fs.rmSync(s, { recursive: true, force: true }));
  expect(fs.existsSync(path.join(s, "agent", "models.json"))).toBe(true);
  expect(fs.existsSync(path.join(s, "agent", "sessions"))).toBe(false);
  expect(fs.existsSync(path.join(s, "evolve"))).toBe(false);
});

// ── the command ──────────────────────────────────────────────────────────────

function io(run?: AttemptRunner) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), run }, out, err };
}

test("mnemo evolve tasks, replay and forget on a project's cards", async () => {
  const f = fixture();
  const t = io(attempt((cwd) => fs.writeFileSync(path.join(cwd, "value.txt"), "42\n")));
  expect(await evolveCommand(["tasks", "--cwd", f.root], f.home, t.io)).toBe(0);
  // The card was written for `repo:<root>`; the command finds the project from --cwd.
  // A fixture repo has no remote, so its identity carries the folder's birth time: rewrite the card under that id.
  const { projectIdentity } = await import("@mnemo/memory");
  const id = projectIdentity(f.root).id;
  writeCard(f.home, { ...f.card, project: { ...f.card.project, id } });
  const t2 = io(t.io.run);
  expect(await evolveCommand(["tasks", "--cwd", f.root], f.home, t2.io)).toBe(0);
  expect(t2.out.join("\n")).toContain(f.card.id);
  expect(t2.out.join("\n")).toContain("check: sh tests/run.sh");

  const t3 = io(t.io.run);
  expect(await evolveCommand(["replay", "--cwd", f.root, "--arm", "both"], f.home, t3.io)).toBe(0);
  const text = t3.out.join("\n");
  expect(text).toContain("memory: 1/1 passed");
  expect(text).toContain("no-memory: 1/1 passed");
  // The first look found the card can judge: that is kept on the card.
  expect(readCards(f.home, id)[0]!.validity).toBe("ok");

  const t4 = io();
  expect(await evolveCommand(["forget", f.card.id, "--cwd", f.root], f.home, t4.io)).toBe(0);
  expect(readCards(f.home, id)).toHaveLength(0);
  expect(await evolveCommand(["forget", f.card.id, "--cwd", f.root], f.home, t4.io)).toBe(1);
});

test("mnemo evolve refuses bad arguments with usage", async () => {
  const home = tmp("mnemo-evolve-home-");
  for (const argv of [[], ["replay", "--arm", "sometimes"], ["replay", "--split", "odd"], ["replay", "--timeout", "-1"], ["replay", "--model", "no spaces allowed"], ["stats", "--days", "x"], ["frobnicate"], ["replay", "--card"]]) {
    const t = io();
    expect(await evolveCommand(argv, home, t.io)).toBe(2);
  }
  const t = io();
  expect(await evolveCommand(["replay", "--card", "nope", "--cwd", home], home, t.io)).toBe(1);
});

test("mnemo evolve stats prints the scorecard and --json the numbers", async () => {
  const cwd = repo();
  const home = tmp("mnemo-evolve-home-");
  const { projectIdentity } = await import("@mnemo/memory");
  const p = projectIdentity(cwd);
  for (let i = 0; i < 3; i++) appendOutcome(home, rec({ project: { id: p.id, name: p.name, root: p.root }, at: `2026-10-0${i + 1}T00:00:00Z` }));
  const t = io();
  expect(await evolveCommand(["stats", "--cwd", cwd], home, t.io)).toBe(0);
  expect(t.out.join("\n")).toMatch(/runs\s+3/);
  const j = io();
  expect(await evolveCommand(["stats", "--cwd", cwd, "--json"], home, j.io)).toBe(0);
  expect(JSON.parse(j.out[0]!)).toMatchObject({ runs: 3, passed: 3 });
});
