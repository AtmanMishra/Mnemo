import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { findHarnessBundles, syncBundlesToSkills } from "../src/skills/harness-bridge.ts";
import { discoverSkills } from "../src/skills/discovery.ts";

describe("harness bridge", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "sea-bridge-"));
  const projectSkills = path.join(tmp, ".pi", "skills");
  const bundle = path.join(projectSkills, "k8s-debug-harness");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({
    name: "k8s-debug",
    version: "1.2.0",
    description: "debug kubernetes deploys",
    tools: ["pod_status", "logs_tail"],
  }));
  writeFileSync(path.join(bundle, "pod_status.mjs"), "export default {};");

  test("finds bundles with manifests", () => {
    const found = findHarnessBundles([projectSkills]);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "k8s-debug");
    assert.deepEqual(found[0].tools, ["pod_status", "logs_tail"]);
  });

  test("sync writes valid SKILL.md that discovery picks up", async () => {
    const written = syncBundlesToSkills([projectSkills]);
    assert.equal(written.length, 1);
    const skillPath = path.join(bundle, "SKILL.md");
    assert.ok(existsSync(skillPath));
    const md = readFileSync(skillPath, "utf8");
    assert.ok(md.includes("name: k8s-debug"));
    assert.ok(md.includes("- pod_status"));
    // #7: the skill a model reads must state the boundary AND its limit.
    assert.match(md, /runs in a CHILD process/);
    assert.match(md, /not\*\* a sandbox|not a sandbox/);

    const skills = await discoverSkills({ cwd: tmp, home: path.join(tmp, "home") });
    const k = skills.find((s) => s.name === "k8s-debug");
    assert.ok(k, "discovery should list the harness as a skill");
    assert.match(k.description, /pod_status/);
  });

  test("sync is idempotent (no rewrite when unchanged)", () => {
    assert.equal(syncBundlesToSkills([projectSkills]).length, 0);
  });

  test("malformed manifest is skipped", () => {
    const badDir = path.join(projectSkills, "broken");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(path.join(badDir, "manifest.json"), "{not json");
    assert.equal(findHarnessBundles([projectSkills]).length, 1); // still just the good one
  });

  test("cleanup", () => rmSync(tmp, { recursive: true, force: true }));
});
