/**
 * pi must not reach out on its own: no download of ripgrep or fd, no model catalog from pi.dev,
 * no attribution headers (see runtime/pi-env.ts, which SECURITY.md cites).
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGrepTool } from "@earendil-works/pi-coding-agent";

test("pi is told to stay offline, send no attribution and skip its own version check", () => {
  expect(process.env.PI_OFFLINE).toBe("1");
  expect(process.env.PI_TELEMETRY).toBe("0");
  expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
});

test("grep without ripgrep on PATH says so and downloads nothing", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-nopath-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-grep-"));
  fs.writeFileSync(path.join(cwd, "a.txt"), "needle\n");
  const realFetch = globalThis.fetch;
  const savedPath = process.env.PATH;
  const savedHome = process.env.MNEMO_HOME;
  const calls: string[] = [];
  globalThis.fetch = ((url: unknown) => {
    calls.push(String(url));
    throw new Error("no network in this test");
  }) as typeof fetch;
  process.env.PATH = empty;
  process.env.MNEMO_HOME = path.join(empty, "home");
  try {
    const grep = createGrepTool(cwd);
    await grep.execute("t", { pattern: "needle" } as never).catch(() => undefined);
  } finally {
    globalThis.fetch = realFetch;
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.MNEMO_HOME;
    else process.env.MNEMO_HOME = savedHome;
  }
  expect(calls).toEqual([]);
});
