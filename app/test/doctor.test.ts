/**
 * `mnemo doctor --fix`: loose permissions on Mnemo's files, a broken
 * state.json and month-old best-of runs are found, reported, and fixed only
 * with --fix.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkMemory, findProblems } from "../src/runtime/doctor.ts";
import { MEMSRV } from "./helpers.ts";

function messyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-doc-"));
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, "agent", "auth.json"), "{}");
  fs.chmodSync(path.join(home, "agent", "auth.json"), 0o644);
  fs.chmodSync(home, 0o755);
  fs.writeFileSync(path.join(home, "state.json"), "{ not json");
  const old = path.join(home, "best-of", "2026-01-01");
  fs.mkdirSync(old, { recursive: true });
  fs.utimesSync(old, new Date("2026-01-01"), new Date("2026-01-01"));
  fs.mkdirSync(path.join(home, "best-of", "today"));
  return home;
}

test.skipIf(process.platform === "win32")("findProblems sees each one and fix puts it right", () => {
  const home = messyHome();
  const problems = findProblems(home);
  expect(problems.map((p) => p.problem).join("\n")).toMatch(/auth\.json is readable by others \(644\)/);
  expect(problems.some((p) => p.problem.includes("state.json is not valid JSON"))).toBe(true);
  expect(problems.some((p) => p.problem.startsWith("1 best-of run older than 30 days"))).toBe(true);
  for (const p of problems) p.fix();
  expect(fs.statSync(path.join(home, "agent", "auth.json")).mode & 0o777).toBe(0o600);
  expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  expect(fs.existsSync(path.join(home, "state.json"))).toBe(false);
  expect(fs.readdirSync(path.join(home, "best-of"))).toEqual(["today"]);
  expect(findProblems(home)).toEqual([]);
});

test.skipIf(process.platform === "win32")("the CLI reports without --fix and repairs with it", () => {
  const home = messyHome();
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "bin", "mnemo.ts"), "doctor", ...args], { env: { ...process.env, MNEMO_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const report = run().stdout.toString();
  expect(report).toContain("✗ ");
  expect(report).toContain("mnemo doctor --fix repairs what it can");
  expect(fs.statSync(path.join(home, "agent", "auth.json")).mode & 0o777).toBe(0o644);
  const fixed = run("--fix").stdout.toString();
  expect(fixed).toContain("fixed   ");
  expect(fs.statSync(path.join(home, "agent", "auth.json")).mode & 0o777).toBe(0o600);
});

test.skipIf(!MEMSRV)("doctor asks memsrv for its count and names the embedder and the log", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-doc-mem-"));
  const journal = path.join(home, "memory", "journal.jsonl");
  const r = await checkMemory(MEMSRV!, journal, home);
  expect(r.ok).toBe(true);
  const text = r.lines.join("\n");
  expect(text).toMatch(/^✓ memory  .* · 0 nodes · answered in \d+ ms$/m);
  expect(text).toContain("  embed   hashing");
  expect(text).toContain(`  log     ${path.join(home, "logs", "memsrv.log")}`);
});

test.skipIf(process.platform === "win32")("a memsrv that does not answer is a doctor failure that points at its log", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-doc-hang-"));
  const hang = path.join(home, "memsrv");
  fs.writeFileSync(hang, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const r = await checkMemory(hang, path.join(home, "memory", "journal.jsonl"), home, 300);
  expect(r.ok).toBe(false);
  expect(r.lines.join("\n")).toBe(`✗ memory  ${hang} did not answer within 0.3 s — its log: ${path.join(home, "logs", "memsrv.log")}`);
});

test.skipIf(!MEMSRV || process.platform === "win32")("mnemo doctor reports memory's count and embedder", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-doc-cli-"));
  const out = Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "bin", "mnemo.ts"), "doctor"], {
    env: { ...process.env, MNEMO_HOME: home, MNEMO_MEMSRV: MEMSRV!, OPENROUTER_API_KEY: "sk-or-not-a-key" },
    stdout: "pipe",
    stderr: "pipe",
  }).stdout.toString();
  expect(out).toMatch(/✓ memory  .* · 0 nodes · answered in \d+ ms/);
  expect(out).toContain("  embed   hashing");
});
