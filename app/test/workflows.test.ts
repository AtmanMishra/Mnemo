// The release workflow's shell steps, run for real against a scratch checkout: a gate
// that lets a wrong release through is only found when the release is already out.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..", "..");
const workflow = (name: string) => Bun.YAML.parse(fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8")) as {
  jobs: Record<string, { steps: { name?: string; run?: string; shell?: string }[] }>;
};
const step = (file: string, job: string, name: string) => {
  const s = workflow(file).jobs[job]!.steps.find((x) => x.name === name);
  if (!s?.run) throw new Error(`no step "${name}" in ${file} ${job}`);
  return s.run;
};
const bash = Bun.which("bash");

describe.if(!!bash && process.platform !== "win32")("release.yml", () => {
  /** A checkout whose three version fields say `version`. */
  function checkout(version: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-wf-"));
    for (const f of ["app/package.json", "packages/memory/package.json"]) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), JSON.stringify({ name: "x", version }));
    }
    fs.mkdirSync(path.join(dir, "memory-layer"));
    fs.writeFileSync(path.join(dir, "memory-layer", "Cargo.toml"), `[package]\nname = "x"\nversion = "${version}"\n`);
    return dir;
  }
  const gate = (tag: string, version: string) =>
    Bun.spawnSync([bash!, "-e", "-c", step("release.yml", "build", "the tag matches the versions")], { cwd: checkout(version), env: { ...process.env, TAG: tag }, stdout: "pipe", stderr: "pipe" });

  test("the tag must match the versions exactly, pre-release part included", () => {
    expect(gate("v0.2.0", "0.2.0").exitCode).toBe(0);
    expect(gate("v0.2.0-rc.1", "0.2.0-rc.1").exitCode).toBe(0);
    // A pre-release tag on a release version (or the other way) would ship a binary reporting the wrong version.
    expect(gate("v0.2.0-rc.1", "0.2.0").exitCode).not.toBe(0);
    expect(gate("v0.2.0", "0.2.0-rc.1").exitCode).not.toBe(0);
    expect(gate("v0.2.0-rc.2", "0.2.0-rc.1").exitCode).not.toBe(0);
  });

  test("publish uploads to a draft and makes it public only once everything is attached", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-wf-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist", "mnemo-linux-x64.tar.gz"), "x");
    const log = path.join(dir, "gh.log");
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
    const r = Bun.spawnSync([bash!, "-e", "-c", step("release.yml", "publish", "publish")], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TAG: "v0.2.0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(calls[0]).toMatch(/^release create v0\.2\.0 .*--draft/);
    expect(calls.at(-1)).toBe("release edit v0.2.0 --draft=false");
  });
});
