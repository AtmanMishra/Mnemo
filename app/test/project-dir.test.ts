/**
 * A folder's own pi resources live in `.agents/`. pi takes that name from a package.json
 * when it loads, so these tests show the name pi really uses and that the old `.pi/` is
 * called out rather than silently ignored.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { PROJECT_DIR, strandedPiResources, useProjectDir } from "../src/runtime/project-dir.ts";

const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

test("pi's project folder is .agents", () => {
  expect(PROJECT_DIR).toBe(".agents");
  expect(CONFIG_DIR_NAME).toBe(".agents");
});

test("the package.json pi reads is written once under the Mnemo home, and a pi package dir someone chose is left alone", () => {
  const home = tmp("mnemo-pkg-");
  const env: Record<string, string | undefined> = { MNEMO_HOME: home };
  useProjectDir(env);
  const file = path.join(home, "pi-package", "package.json");
  expect(env.PI_PACKAGE_DIR).toBe(path.join(home, "pi-package"));
  expect(JSON.parse(fs.readFileSync(file, "utf8")).piConfig).toEqual({ configDir: ".agents" });
  const before = fs.statSync(file).mtimeMs;
  useProjectDir({ MNEMO_HOME: home });
  expect(fs.statSync(file).mtimeMs).toBe(before);

  const chosen: Record<string, string | undefined> = { MNEMO_HOME: tmp("mnemo-pkg-"), PI_PACKAGE_DIR: "/somewhere/else" };
  useProjectDir(chosen);
  expect(chosen.PI_PACKAGE_DIR).toBe("/somewhere/else");
  expect(fs.existsSync(path.join(chosen.MNEMO_HOME!, "pi-package"))).toBe(false);
});

test("what a folder still keeps under .pi is named, unless .agents has its own", () => {
  const cwd = tmp("mnemo-stranded-");
  expect(strandedPiResources(cwd)).toEqual([]);
  fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "mcp.json"), "{}");
  expect(strandedPiResources(cwd)).toEqual(["extensions", "mcp.json"]);
  fs.mkdirSync(path.join(cwd, ".agents"));
  fs.writeFileSync(path.join(cwd, ".agents", "mcp.json"), "{}");
  expect(strandedPiResources(cwd)).toEqual(["extensions"]);
});
