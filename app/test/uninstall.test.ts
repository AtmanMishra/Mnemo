/**
 * mnemo uninstall: the program goes and what it learned stays; --deep also
 * deletes the data folder, but only one that is plainly Mnemo's; without a
 * terminal nothing happens unless --yes says so.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describePlan, looksLikeMnemoHome, planUninstall, runUninstall } from "../src/runtime/uninstall.ts";

function installed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-un-"));
  const home = path.join(root, ".mnemo");
  const links = path.join(root, "links");
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, "memory"), { recursive: true });
  fs.mkdirSync(path.join(home, "agent", "sessions"), { recursive: true });
  fs.mkdirSync(links);
  for (const f of ["mnemo", "memsrv"]) fs.writeFileSync(path.join(home, "bin", f), "bin");
  fs.writeFileSync(path.join(home, "memory", "journal.jsonl"), "x".repeat(2048));
  fs.writeFileSync(path.join(home, "agent", "auth.json"), "{}");
  fs.writeFileSync(path.join(home, "state.json"), "{}");
  fs.symlinkSync(path.join(home, "bin", "mnemo"), path.join(links, "mnemo"));
  return { root, home, links };
}

test.skipIf(process.platform === "win32")("plain: binaries and our link go, memory stays", () => {
  const { home, links } = installed();
  const plan = planUninstall({ kind: "installer", home, deep: false, linkDir: links });
  expect(plan.files.map((f) => path.basename(f)).sort()).toEqual(["memsrv", "mnemo"]);
  expect(plan.link).toBe(path.join(links, "mnemo"));
  expect(plan.data).toBeUndefined();
  runUninstall(plan);
  expect(fs.existsSync(path.join(home, "bin", "mnemo"))).toBe(false);
  expect(fs.existsSync(path.join(links, "mnemo"))).toBe(false);
  expect(fs.readFileSync(path.join(home, "memory", "journal.jsonl"), "utf8")).toHaveLength(2048);
});

test.skipIf(process.platform === "win32")("deep: says what is in the folder, then deletes it", () => {
  const { home, links } = installed();
  const plan = planUninstall({ kind: "installer", home, deep: true, linkDir: links });
  const text = describePlan(plan).join("\n");
  expect(text).toContain(`delete  ${home}`);
  expect(text).toMatch(/memory \(what Mnemo learned\)\s+2\.0 KB/);
  expect(text).toContain("credentials from /login");
  runUninstall(plan);
  expect(fs.existsSync(home)).toBe(false);
});

test("a folder that is not plainly Mnemo's is never deleted whole", () => {
  const { root, home } = installed();
  expect(looksLikeMnemoHome(home)).toBe(true);
  // What Mnemo writes at the root of its home: saved approvals, permission rules, skill history, state.
  for (const f of ["grants.json", "permissions.json", "state.json.tmp", ".env", "journal.jsonl"]) fs.writeFileSync(path.join(home, f), "{}");
  fs.mkdirSync(path.join(home, "skill-history"));
  expect(looksLikeMnemoHome(home)).toBe(true);
  fs.writeFileSync(path.join(home, "thesis.docx"), "mine");
  expect(looksLikeMnemoHome(home)).toBe(false);
  expect(looksLikeMnemoHome(os.homedir())).toBe(false);
  expect(looksLikeMnemoHome("/")).toBe(false);
  expect(looksLikeMnemoHome(path.join(root, "nope"))).toBe(false);
});

test.skipIf(process.platform === "win32")("the CLI: without a terminal it asks for --yes; with it, --deep deletes the data", () => {
  const { home } = installed();
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "bin", "mnemo.ts"), "uninstall", ...args], { env: { ...process.env, MNEMO_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const refused = run("--deep");
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr.toString()).toContain("add --yes");
  expect(fs.existsSync(home)).toBe(true);
  const done = run("--deep", "--yes");
  expect(done.stdout.toString()).toContain(`✓ deleted ${home}`);
  expect(fs.existsSync(home)).toBe(false);
  expect(run("--bogus").exitCode).toBe(2);
});
