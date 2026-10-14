/**
 * Best-of-n with stand-in candidates: each works in its own worktree started
 * from the working tree as it is, the check judges, the smallest passing
 * change is applied, and ignored dependency folders are shared but never part
 * of a diff.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bestOf, describeBestOf } from "../src/runtime/best-of.ts";

function repo(ignore = "node_modules/\n"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-bo-"));
  const run = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir });
  run("init", "-q");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  // Windows git defaults to autocrlf=true, which would hand every worktree CRLF files.
  run("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "value.txt"), "0\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ignore);
  run("add", "-A");
  run("commit", "-qm", "init");
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "dep.txt"), "dep\n");
  return dir;
}

test("the smallest change that passes the check is applied, from the working tree as it was", async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "notes.txt"), "untracked\n");
  fs.writeFileSync(path.join(dir, "value.txt"), "1\n"); // uncommitted: the candidates start from it
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-bo-keep-"));
  const r = await bestOf({
    n: 3,
    cwd: dir,
    // passes when value.txt says 2 and the shared dependency is reachable
    check: "grep -qx 2 value.txt && test -f node_modules/dep.txt",
    keepDir: keep,
    run: async (i, cwd) => {
      expect(fs.readFileSync(path.join(cwd, "value.txt"), "utf8")).toBe("1\n");
      if (i === 0) fs.writeFileSync(path.join(cwd, "value.txt"), "3\n"); // wrong
      if (i === 1) fs.writeFileSync(path.join(cwd, "value.txt"), "2\n"); // right, small
      if (i === 2) {
        fs.writeFileSync(path.join(cwd, "value.txt"), "2\n"); // right, but bigger
        fs.writeFileSync(path.join(cwd, "extra.txt"), "a\nb\nc\n");
      }
      return `answer ${i + 1}`;
    },
  });
  expect(r.candidates.map((c) => c.passed)).toEqual([false, true, true]);
  expect(r.winner?.i).toBe(2);
  expect(fs.readFileSync(path.join(dir, "value.txt"), "utf8")).toBe("2\n");
  expect(fs.existsSync(path.join(dir, "extra.txt"))).toBe(false);
  expect(r.candidates.every((c) => !c.patch.includes("node_modules"))).toBe(true);
  expect(fs.readdirSync(keep).filter((f) => f.endsWith(".patch")).sort()).toEqual(["candidate-1.patch", "candidate-2.patch", "candidate-3.patch"]);
  expect(describeBestOf(r)).toContain("applied candidate 2");
  // the worktrees are gone
  expect(Bun.spawnSync(["git", "worktree", "list"], { cwd: dir }).stdout.toString().trim().split("\n")).toHaveLength(1);
});

test("a dependency folder ignored as a name, not only as a directory, stays out of the diff", async () => {
  for (const ignore of ["node_modules\n", ""]) {
    const dir = repo(ignore);
    if (!ignore) Bun.spawnSync(["git", "add", "-A"], { cwd: dir }); // not even ignored: tracked as untracked folder
    const r = await bestOf({
      n: 2,
      cwd: dir,
      check: "grep -qx 5 value.txt",
      keepDir: fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-bo-keep-")),
      run: async (_i, cwd) => (fs.writeFileSync(path.join(cwd, "value.txt"), "5\n"), "ok"),
    });
    expect(r.candidates.map((c) => c.error)).toEqual([undefined, undefined]);
    expect(r.winner?.patch).not.toContain("node_modules");
  }
});

test("when nothing passes, nothing is applied", async () => {
  const dir = repo();
  const r = await bestOf({
    n: 2,
    cwd: dir,
    check: "false",
    keepDir: fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-bo-keep-")),
    run: async (i, cwd) => {
      if (i === 0) throw new Error("model unavailable");
      fs.writeFileSync(path.join(cwd, "value.txt"), "9\n");
      return "";
    },
  });
  expect(r.winner).toBeUndefined();
  expect(r.candidates[0]!.error).toBe("model unavailable");
  expect(fs.readFileSync(path.join(dir, "value.txt"), "utf8")).toBe("0\n");
  expect(describeBestOf(r)).toContain("nothing applied");
});

test("the check runs without the keys models.json names, as the agent's commands do", async () => {
  const dir = repo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-bo-home-"));
  fs.mkdirSync(path.join(home, "agent"));
  fs.writeFileSync(path.join(home, "agent", "models.json"), JSON.stringify({ providers: { corp: { apiKey: "$MNEMO_TEST_CORP_KEY" } } }));
  process.env.MNEMO_TEST_CORP_KEY = "corp-secret";
  try {
    const r = await bestOf({
      n: 1,
      cwd: dir,
      check: 'test -z "$MNEMO_TEST_CORP_KEY"',
      // Where the controller keeps them: $MNEMO_HOME/best-of/<run>.
      keepDir: path.join(home, "best-of", "run"),
      run: async (_i, cwd) => {
        fs.writeFileSync(path.join(cwd, "value.txt"), "2\n");
        return "ok";
      },
    });
    expect(r.candidates[0]!.passed).toBe(true);
  } finally {
    delete process.env.MNEMO_TEST_CORP_KEY;
  }
});

test("a check that overruns is stopped with everything it started", async () => {
  if (process.platform === "win32") return;
  const dir = repo();
  const marker = path.join(dir, "..", `${path.basename(dir)}-late`);
  const t0 = Date.now();
  const r = await bestOf({
    n: 1,
    cwd: dir,
    // The shell forks `sleep`, which keeps the output pipe open after the shell is killed.
    check: `sleep 2; touch ${marker}; sleep 30`,
    checkTimeoutMs: 300,
    keepDir: fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-bo-keep-")),
    run: async (_i, cwd) => {
      fs.writeFileSync(path.join(cwd, "value.txt"), "2\n");
      return "ok";
    },
  });
  // Twice (the check is retried once), each well under the 2s sleep.
  expect(Date.now() - t0).toBeLessThan(3500);
  expect(r.candidates[0]!.passed).toBe(false);
  await Bun.sleep(2500);
  expect(fs.existsSync(marker)).toBe(false);
}, 20_000);
