/**
 * Cut a release in two steps, so it works with a protected main:
 *
 *   bun app/scripts/release.ts prepare 0.1.0   a branch release/v0.1.0 with the
 *                                              versions bumped and the checks run
 *   (open a PR from it, merge it)
 *   bun app/scripts/release.ts tag 0.1.0       on an up-to-date main whose
 *                                              versions are 0.1.0: tag v0.1.0
 *   bun app/scripts/release.ts tag 0.1.0 --push   …and push the tag, which starts
 *                                              the release workflow
 *
 * Pushing the tag is the only step that publishes anything, and it is never
 * implicit. docs/RELEASING.md has the whole flow.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
/** Every file whose first `version` is the release's version. */
export const VERSIONED = ["app/package.json", "packages/memory/package.json", "memory-layer/Cargo.toml"];

/** `text` with its first version field set to `version` (a package.json or a Cargo.toml). */
export function bump(text: string, version: string, file: string): string {
  const re = file.endsWith(".toml") ? /^version\s*=\s*"[^"]*"/m : /"version":\s*"[^"]*"/;
  if (!re.test(text)) throw new Error(`no version field in ${file}`);
  return text.replace(re, (m) => (file.endsWith(".toml") ? `version = "${version}"` : m.replace(/"[^"]*"$/, `"${version}"`)));
}

/** The first version in a package.json or Cargo.toml. */
export function versionOf(text: string, file: string): string | undefined {
  const m = (file.endsWith(".toml") ? /^version\s*=\s*"([^"]*)"/m : /"version":\s*"([^"]*)"/).exec(text);
  return m?.[1];
}

function run(cmd: string[], cwd = ROOT, quiet = false): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: quiet ? "pipe" : "inherit" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed${quiet ? `: ${r.stderr?.toString().trim()}` : ""}`);
  return r.stdout.toString().trim();
}

function die(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

function clean(): void {
  if (run(["git", "status", "--porcelain"], ROOT, true)) die("the working tree is not clean; commit or stash first");
}

function prepare(version: string, skipTests: boolean): void {
  clean();
  if (run(["git", "tag", "-l", `v${version}`], ROOT, true)) die(`tag v${version} already exists`);
  const branch = `release/v${version}`;
  run(["git", "checkout", "-b", branch]);
  for (const f of VERSIONED) {
    const file = path.join(ROOT, f);
    fs.writeFileSync(file, bump(fs.readFileSync(file, "utf8"), version, f));
  }
  // Cargo.lock records the crate's own version; the release builds with --locked.
  run(["cargo", "update", "--workspace", "--offline"], path.join(ROOT, "memory-layer"));
  if (!skipTests) {
    run(["bunx", "tsc", "--noEmit"], path.join(ROOT, "app"));
    run(["bun", "test", "./test"], path.join(ROOT, "app"));
    run(["bun", "test", "./test"], path.join(ROOT, "packages", "memory"));
  }
  run(["git", "add", ...VERSIONED, "memory-layer/Cargo.lock"]);
  run(["git", "commit", "-m", `release v${version}`]);
  console.log(`\nprepared ${branch}. Next:\n  git push -u origin ${branch}\n  open a pull request, merge it, then:\n  git checkout main && git pull\n  bun app/scripts/release.ts tag ${version} --push`);
}

function tag(version: string, push: boolean): void {
  clean();
  if (run(["git", "rev-parse", "--abbrev-ref", "HEAD"], ROOT, true) !== "main") die("tag from main (git checkout main && git pull)");
  run(["git", "fetch", "-q", "origin", "main"]);
  if (run(["git", "rev-parse", "HEAD"], ROOT, true) !== run(["git", "rev-parse", "origin/main"], ROOT, true)) die("main is not the same as origin/main; pull first");
  for (const f of VERSIONED) {
    const v = versionOf(fs.readFileSync(path.join(ROOT, f), "utf8"), f);
    if (v !== version) die(`${f} says ${v}, not ${version}: merge the release PR first`);
  }
  if (run(["git", "tag", "-l", `v${version}`], ROOT, true)) die(`tag v${version} already exists`);
  run(["git", "tag", "-a", `v${version}`, "-m", `Mnemo v${version}`]);
  if (!push) return console.log(`tagged v${version} locally. Publish it with:\n  git push origin v${version}`);
  run(["git", "push", "origin", `v${version}`]);
  console.log(`pushed v${version}: the release workflow is running.`);
}

if (import.meta.main) {
  const [cmd, version, ...flags] = process.argv.slice(2);
  if (!version || !VERSION.test(version) || (cmd !== "prepare" && cmd !== "tag")) die("usage: release.ts prepare|tag <version, e.g. 0.1.0> [--push] [--skip-tests]");
  if (cmd === "prepare") prepare(version, flags.includes("--skip-tests"));
  else tag(version, flags.includes("--push"));
}
