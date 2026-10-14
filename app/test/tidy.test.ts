/**
 * `mnemo memory tidy`: reports duplicates, facts about files that are gone and
 * what was marked wrong twice; changes nothing without --apply; with it,
 * retires them and leaves the rest.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { journalPath, MemoryService, pathsIn, projectIdentity, sameMeaning } from "@mnemo/memory";
import { runMemoryCommand } from "../src/memory-cli.ts";
import { MEMSRV } from "./helpers.ts";

test("same meaning and file paths", () => {
  expect(sameMeaning("pnpm", "PNPM.")).toBe(true);
  expect(sameMeaning("run the tests with bun test --watch", "run tests with bun test --watch")).toBe(true);
  expect(sameMeaning("run tests with bun test", "run tests with npm test")).toBe(false);
  expect(sameMeaning("deploy with fly from the main branch only", "deploy with fly, from the main branch only")).toBe(true);
  expect(pathsIn("entry is `src/old/main.ts`, see docs/a.md or https://x.io/a.js; /etc/hosts.txt")).toEqual(["src/old/main.ts", "docs/a.md"]);
});

test("opposite orders are not the same meaning, and versions are not file paths", () => {
  expect(sameMeaning("use pnpm, never npm", "use npm, never pnpm")).toBe(false);
  expect(sameMeaning("deploy staging before production, never after", "deploy production before staging, never after")).toBe(false);
  expect(pathsIn("CI matrix runs Python 3.11/3.12")).toEqual([]);
  expect(pathsIn("supports node 18.x/20.x")).toEqual([]);
  expect(pathsIn("config lives in config/app.conf and lib/x.rs")).toEqual(["config/app.conf", "lib/x.rs"]);
});

test.skipIf(!MEMSRV)("tidy in one project never retires another project's pitfalls", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-tidy-scope-"));
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-tidy-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-tidy-b-"));
  const mem = new MemoryService(MEMSRV!, journalPath(home));
  const projectB = (await mem.project(projectIdentity(b).id, b))!;
  for (let i = 0; i < 2; i++) {
    const pit = (await mem.createNode("aspect", `pain: vitest not found ${i}`, "salience"))!;
    await mem.fact(pit, "failure", "bash(pnpm vitest) failed: sh: vitest: not found");
    await mem.fact(pit, "fix", "pnpm install first");
    await mem.link(pit, projectB, "part_of");
  }
  mem.stop();
  const out = sink();
  expect(await runMemoryCommand(["tidy", "--cwd", a], home, path.join(home, "agent"), out.stream, out.stream)).toBe(0);
  expect(out.text()).toContain("is tidy");
  const inB = sink();
  await runMemoryCommand(["tidy", "--cwd", b], home, path.join(home, "agent"), inB.stream, inB.stream);
  expect(inB.text()).toContain("duplicate   pitfall");
});

function sink() {
  let text = "";
  return { stream: { write: (s: string) => ((text += s), true) } as never, text: () => text };
}

test.skipIf(!MEMSRV)("tidy reports, then --apply retires, and keeps the rest", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-tidy-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-tidy-proj-"));
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(path.join(project, "src", "app.ts"), "");
  process.env.MNEMO_MEMSRV = MEMSRV;
  const id = projectIdentity(project).id;
  const mem = new MemoryService(MEMSRV!, journalPath(home));
  await mem.learn("project", id, "package manager", "pnpm");
  await mem.learn("project", id, "pkg", "PNPM");
  await mem.learn("project", id, "entry", "the entry point is src/old/main.ts");
  await mem.learn("project", id, "app", "the app starts in src/app.ts");
  const note = (await mem.remember("deploys go out with the legacy rsync script"))!;
  await mem.markUseful(note, false);
  await mem.markUseful(note, false);
  mem.stop();

  const dry = sink();
  expect(await runMemoryCommand(["tidy", "--cwd", project], home, path.join(home, "agent"), dry.stream, dry.stream)).toBe(0);
  expect(dry.text()).toContain("duplicate   project · pkg");
  expect(dry.text()).toContain("stale       project · entry");
  expect(dry.text()).toContain("distrusted");
  expect(dry.text()).toContain("3 to retire");

  const check = new MemoryService(MEMSRV!, journalPath(home));
  expect((await check.profile("project", id)).map((f) => f.key).sort()).toEqual(["app", "entry", "package manager", "pkg"]);
  check.stop();

  const wet = sink();
  expect(await runMemoryCommand(["tidy", "--cwd", project, "--apply"], home, path.join(home, "agent"), wet.stream, wet.stream)).toBe(0);
  expect(wet.text()).toContain("retired 3 of 3");
  const after = new MemoryService(MEMSRV!, journalPath(home));
  expect((await after.profile("project", id)).map((f) => f.key).sort()).toEqual(["app", "package manager"]);
  expect((await after.nodes()).some((n) => n.id === note)).toBe(false);
  after.stop();

  const again = sink();
  await runMemoryCommand(["tidy", "--cwd", project], home, path.join(home, "agent"), again.stream, again.stream);
  expect(again.text()).toContain("is tidy");
});
