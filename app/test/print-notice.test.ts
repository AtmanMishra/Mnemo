import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { printNotice } from "../src/runtime/print-notice.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const folder = () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-notice-")));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

test("a clean repository and plan mode get no notice", () => {
  const d = folder();
  git(d, "init", "-q");
  fs.writeFileSync(path.join(d, "a.txt"), "a");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  expect(printNotice(d, "default")).toBeUndefined();
  fs.writeFileSync(path.join(d, "b.txt"), "b");
  expect(printNotice(d, "plan")).toBeUndefined();
});

test("uncommitted work is named", () => {
  const d = folder();
  git(d, "init", "-q");
  fs.writeFileSync(path.join(d, "a.txt"), "a");
  expect(printNotice(d, "default")).toContain("uncommitted changes");
});

test("a folder that is no repository is named", () => {
  expect(printNotice(folder(), "yolo")).toContain("not a git repository");
});
