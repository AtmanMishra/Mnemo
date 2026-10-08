/**
 * Project identity: a folder keeps its identity across sessions, and a new
 * folder at the same path (the next container's /app) gets a new one.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeRemote, projectIdentity } from "../src/index.ts";

test("a folder outside git keeps its identity; a new folder at the same path does not share it", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-id-"));
  const dir = path.join(parent, "app");
  fs.mkdirSync(dir);
  const first = projectIdentity(dir);
  expect(first.id.startsWith(`dir:${dir}`)).toBe(true);
  expect(projectIdentity(dir).id).toBe(first.id);
  if (!first.id.includes("@")) return; // this filesystem reports no creation time
  fs.rmSync(dir, { recursive: true });
  await new Promise((r) => setTimeout(r, 20));
  fs.mkdirSync(dir);
  expect(projectIdentity(dir).id).not.toBe(first.id);
  expect(projectIdentity(dir).name).toBe("app");
});

test("remotes normalize to one identity for every clone", () => {
  expect(normalizeRemote("git@github.com:Owner/Repo.git")).toBe("github.com/owner/repo");
  expect(normalizeRemote("https://user@github.com/Owner/Repo/")).toBe("github.com/owner/repo");
});
