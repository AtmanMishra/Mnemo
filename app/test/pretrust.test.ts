/**
 * Opening a folder runs nothing the folder chose. The `@` file list and best-of
 * call git in a folder nobody has trusted yet, and a repository can carry config
 * that makes git run a command (`core.fsmonitor`, hooks) or ship its own `git`.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trustedBin } from "../src/runtime/bin.ts";
import { listFiles } from "../src/ui/files.ts";
import { bestOf } from "../src/runtime/best-of.ts";

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-pretrust-")));
  const run = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir });
  run("init", "-q");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  run("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  return dir;
}

test("the @ file list does not run the repository's fsmonitor", () => {
  const dir = repo();
  const marker = path.join(dir, "ran");
  Bun.spawnSync(["git", "config", "core.fsmonitor", "echo x > ran; false"], { cwd: dir });
  // Without the guard git runs it: the test can tell.
  Bun.spawnSync(["git", "ls-files", "--others"], { cwd: dir });
  expect(fs.existsSync(marker)).toBe(true);
  fs.rmSync(marker);

  expect(listFiles(dir)).toContain("a.txt");
  expect(fs.existsSync(marker)).toBe(false);
});

test("best-of's worktrees run no repository hook or fsmonitor", async () => {
  const dir = repo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-pretrust-out-"));
  const at = (name: string) => path.join(out, name).split(path.sep).join("/");
  const hooks = path.join(dir, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\necho x > "${at("hook")}"\n`, { mode: 0o755 });
  Bun.spawnSync(["git", "config", "core.fsmonitor", `echo x > "${at("fsmonitor")}"; false`], { cwd: dir });
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-pretrust-keep-"));
  const r = await bestOf({ n: 1, cwd: dir, check: "exit 0", keepDir: keep, run: async () => "done" });
  expect(r.candidates).toHaveLength(1);
  expect(fs.readdirSync(out)).toEqual([]);
});

test("a program is never found in the current folder, whatever PATH says", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-pretrust-bin-")));
  const name = "mnemo-planted-tool";
  const file = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
  fs.copyFileSync(process.execPath, file);
  fs.chmodSync(file, 0o755);
  const sep = process.platform === "win32" ? ";" : ":";
  // Found where PATH names the folder absolutely...
  expect(trustedBin(name, { PATH: dir })).toBeDefined();
  // ...but not through `.` or an empty entry while Mnemo is in it.
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect(trustedBin(name, { PATH: ["", "."].join(sep) })).toBeUndefined();
  } finally {
    process.chdir(cwd);
  }
});
