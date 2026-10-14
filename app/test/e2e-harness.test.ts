import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { memsrv, world } from "../e2e/harness.ts";

test("the release sidecar path is absolute and normalized before it is copied", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-e2e-sidecar-")));
  const previous = process.env.MNEMO_MEMSRV;
  try {
    fs.mkdirSync(path.join(base, "app"));
    fs.mkdirSync(path.join(base, "stage"));
    const name = process.platform === "win32" ? "memsrv.exe" : "memsrv";
    const source = path.join(base, "stage", name);
    fs.writeFileSync(source, "sidecar fixture");
    // Git Bash exports forward slashes and /../ in the release workflow.
    process.env.MNEMO_MEMSRV = `${base.replaceAll("\\", "/")}/app/../stage/${name}`;
    expect(memsrv()).toBe(source);
    const copied = path.join(base, name);
    fs.copyFileSync(memsrv()!, copied);
    expect(fs.readFileSync(copied, "utf8")).toBe("sidecar fixture");
  } finally {
    if (previous === undefined) delete process.env.MNEMO_MEMSRV;
    else process.env.MNEMO_MEMSRV = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a world has a real initial commit despite inherited Git configuration", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-e2e-git-"));
  const previous = process.env.GIT_CONFIG_SYSTEM;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  let w: ReturnType<typeof world> | undefined;
  try {
    const config = path.join(base, "system.gitconfig");
    fs.writeFileSync(config, "[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = mnemo-no-such-signing-program\n");
    process.env.GIT_CONFIG_SYSTEM = config;
    process.env.GIT_CONFIG_NOSYSTEM = "0";
    w = world();
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: w!.project, env: w!.env, stdout: "pipe", stderr: "pipe" });
    const head = git("rev-parse", "--verify", "HEAD");
    expect({ code: head.exitCode, stderr: head.stderr.toString() }).toEqual({ code: 0, stderr: "" });
    expect(fs.realpathSync(git("rev-parse", "--show-toplevel").stdout.toString().trim())).toBe(w.project);
    expect(git("status", "--porcelain").stdout.toString()).toBe("");
    // A normal file works for Git for Windows too; os.devNull is a device path there.
    expect(fs.statSync(w.env.GIT_CONFIG_GLOBAL!).isFile()).toBe(true);
  } finally {
    w?.cleanup();
    if (previous === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = previous;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a broken Git fixture reports the failing setup command immediately", () => {
  let w: ReturnType<typeof world> | undefined;
  try {
    expect(() => { w = world({ files: { ".git": "not a git directory\n" } }); }).toThrow(/git init failed/);
  } finally {
    w?.cleanup();
  }
});
