/**
 * Updating: versions compare as versions, the install is recognised from where
 * the binary is, the daily check runs only when turned on, the latest release is
 * read from GitHub's redirect, and /update says what it will do.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearReplaced, compareVersions, installKind, latestVersion, manualStep, shouldCheck } from "../src/runtime/update.ts";
import type { Updater } from "../src/runtime/controller.ts";
import { mnemoEnv } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

test("versions compare by number, and a pre-release comes before its release", () => {
  expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
  expect(compareVersions("v0.1.1", "0.1.1")).toBe(0);
  expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(-1);
  expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
  expect(compareVersions("1.0", "1.0.0")).toBe(0);
});

test("the install is recognised from where the binary is", () => {
  expect(installKind("/home/a/.mnemo/bin/mnemo", "/home/a/.mnemo")).toBe("installer");
  expect(installKind("C:\\Users\\a\\.mnemo\\bin\\mnemo.exe", "C:\\Users\\a\\.mnemo")).toBe("installer");
  expect(installKind("/opt/homebrew/Cellar/mnemo/0.1.1/bin/mnemo", "/home/a/.mnemo")).toBe("homebrew");
  expect(installKind("C:\\Users\\a\\scoop\\apps\\mnemo\\current\\mnemo.exe", "C:\\Users\\a\\.mnemo")).toBe("scoop");
  expect(installKind("/usr/local/bin/bun", "/home/a/.mnemo")).toBe("source");
  expect(installKind("/usr/local/bin/mnemo", "/home/a/.mnemo")).toBe("elsewhere");
  expect(manualStep("homebrew", "0.2.0")).toBe("brew upgrade mnemo");
  expect(manualStep("elsewhere", "0.2.0")).toContain("releases/download/v0.2.0/install.");
});

test("the daily check runs only when turned on, and at most once a day", () => {
  const day = 24 * 60 * 60 * 1000;
  expect(shouldCheck({ now: day * 10, env: {} })).toBe(false);
  expect(shouldCheck({ auto: true, now: day * 10, env: {} })).toBe(true);
  expect(shouldCheck({ auto: true, checkedAt: day * 10 - 1000, now: day * 10, env: {} })).toBe(false);
  expect(shouldCheck({ auto: true, checkedAt: day * 9 - 1, now: day * 10, env: {} })).toBe(true);
  expect(shouldCheck({ now: day, env: { MNEMO_AUTO_UPDATE: "1" } })).toBe(true);
  expect(shouldCheck({ auto: true, now: day, env: { MNEMO_AUTO_UPDATE: "0" } })).toBe(false);
});

test("the latest release is read from where releases/latest redirects; offline is undefined", async () => {
  const redirect = (async () =>
    new Response(null, { status: 302, headers: { location: "https://github.com/AtmanMishra/Mnemo/releases/tag/v0.3.1" } })) as unknown as typeof fetch;
  expect(await latestVersion(redirect)).toBe("0.3.1");
  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect(await latestVersion(offline)).toBeUndefined();
});

async function withUpdater(u: Partial<Updater>) {
  const calls: string[] = [];
  const e = await mnemoEnv({
    updater: {
      current: "0.1.1",
      kind: "installer",
      latest: async () => "0.1.1",
      install: async () => 0,
      setAuto: (on: boolean) => void calls.push(`auto ${on}`),
      ...u,
    },
  });
  envs.push(e);
  const snap = () => e.controller.transcript.snapshot();
  const notices = () => [...snap().committed, ...snap().live].filter((b) => b.kind === "notice").map((b) => (b as { text: string }).text);
  return { e, calls, notices };
}

test("/update says when this is the latest, and points a package manager's copy to it", async () => {
  const a = await withUpdater({});
  await a.e.controller.submit("/update");
  expect(a.notices().at(-1)).toBe("Mnemo v0.1.1 is the latest.");
  const b = await withUpdater({ latest: async () => "0.2.0", kind: "homebrew" });
  await b.e.controller.submit("/update");
  expect(b.notices().at(-1)).toContain("brew upgrade mnemo");
});

test("/update auto on|off turns the daily check on and off", async () => {
  const a = await withUpdater({});
  await a.e.controller.submit("/update auto on");
  await a.e.controller.submit("/update auto off");
  expect(a.calls).toEqual(["auto true", "auto false"]);
  expect(a.notices().at(-1)).toContain("no request of its own");
});

test("clearReplaced deletes every binary the Windows installer moved aside, whatever its name", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-old-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  for (const f of ["mnemo.exe", "mnemo.exe.old", "mnemo.exe.k3j2h1g0f9e.old", "memsrv.exe.a1b2c3d4e5f.old", "notes.txt"]) fs.writeFileSync(path.join(bin, f), "x");
  clearReplaced(home);
  expect(fs.readdirSync(bin).sort()).toEqual(["mnemo.exe", "notes.txt"]);
  clearReplaced(path.join(home, "nowhere")); // no bin: nothing to do, no throw
});
