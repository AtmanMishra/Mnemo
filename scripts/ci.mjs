#!/usr/bin/env node
/**
 * One command that mirrors what CI runs, locally.
 *
 * The matrix lives in .github/workflows/ci.yml and a contributor had no way to
 * run the equivalent without reading it. This runs the same five things in the
 * same order and reports one table, so "it passes here" and "it passes there"
 * mean the same thing — including the parts that only fail on another platform,
 * which is how the trust-path bug was found (Linux agreed with itself, macOS
 * did not).
 *
 *   node scripts/ci.mjs              everything
 *   node scripts/ci.mjs --fast       skip cargo (the slowest by far)
 *   node scripts/ci.mjs --only go    one suite: agent | rust | go | harness
 *
 * Exit code is 0 only if every selected suite passed. The secret scan is not
 * included on purpose: it reads the last 200 commits and belongs to the
 * repository, not to a working tree.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const fast = args.includes("--fast");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

/** @type {{name: string, cwd: string, cmd: string, argv: string[], needs?: string}[]} */
const SUITES = [
  { name: "agent  (tests)", cwd: "agent", cmd: "npm", argv: ["test"] },
  { name: "agent  (types)", cwd: "agent", cmd: "npx", argv: ["tsc", "--noEmit"] },
  { name: "rust   (tests)", cwd: "memory-layer", cmd: "cargo", argv: ["test"], needs: "cargo" },
  { name: "go     (tests)", cwd: "tui-go", cmd: "go", argv: ["test", "./..."] },
  { name: "go     (vet)", cwd: "tui-go", cmd: "go", argv: ["vet", "./..."] },
  { name: "harness (tests)", cwd: "harness-engine", cmd: "npm", argv: ["test"] },
];

const GROUP = (cwd) => (cwd === "agent" ? "agent" : cwd === "memory-layer" ? "rust" : cwd === "tui-go" ? "go" : "harness");

/** Is this toolchain on PATH at all? A suite whose tool is missing is skipped,
 *  not failed — a contributor without Rust should still be able to run the Go
 *  suite, and the table says which ones ran. */
function have(cmd) {
  const probe = spawnSync(cmd, ["--version"], { shell: process.platform === "win32", stdio: "ignore" });
  return probe.status === 0 || probe.error === undefined;
}

const selected = SUITES.filter((s) => {
  if (only && GROUP(s.cwd) !== only) return false;
  if (fast && s.cwd === "memory-layer") return false;
  if (s.needs && !have(s.needs)) return false;
  return true;
});

function run(suite) {
  const started = Date.now();
  const res = spawnSync(suite.cmd, suite.argv, {
    cwd: path.join(ROOT, suite.cwd),
    shell: process.platform === "win32", // npm/go are .cmd shims there
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { ...suite, code: res.status ?? 1, ms: Date.now() - started, out };
}

/** The lines that explain a failure, so the table is not the only evidence. */
function why(out) {
  const lines = out.split(/\r?\n/).filter((l) => /^\s*(not ok|FAIL|error|✗|panicked)/i.test(l));
  return lines.slice(0, 3).map((l) => l.trim());
}

if (selected.length === 0) {
  console.error(only ? `nothing to run for --only ${only}` : "nothing to run");
  process.exit(2);
}
if (!fs.existsSync(path.join(ROOT, "agent", "node_modules"))) {
  console.error("agent/node_modules is missing — run `npm install` in agent/ first");
  process.exit(2);
}

console.log(`running ${selected.length} suites from ${ROOT}\n`);
const results = [];
for (const suite of selected) {
  process.stdout.write(`${suite.name.padEnd(16)} … `);
  const r = run(suite);
  results.push(r);
  console.log(`${r.code === 0 ? "ok" : "FAILED"}  ${(r.ms / 1000).toFixed(1)}s`);
  if (r.code !== 0) for (const line of why(r.out)) console.log(`      ${line}`);
  if (r.code !== 0) fs.writeFileSync(path.join(ROOT, `.ci-${suite.cwd.replace(/\W+/g, "-")}.log`), r.out);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
if (failed.length) {
  console.log(`full output: ${failed.map((f) => `.ci-${f.cwd.replace(/\W+/g, "-")}.log`).join(", ")}`);
  process.exit(1);
}
