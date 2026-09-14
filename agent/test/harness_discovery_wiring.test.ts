/**
 * WIRING test: list_skills runs discovery-time harness indexing against the
 * real memsrv, idempotently.
 *
 * This lives in its OWN file (own process) on purpose: the shared memory
 * client binds its journal path when its module first loads, and node --test
 * runs each file in a fresh process — so by setting MNEMO_MEMORY_JOURNAL
 * before the first import in THIS process, the sidecar writes to a temp
 * journal. Nobody imports skills.ts / memory-layer.ts statically here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// The sidecar is memsrv.exe on Windows (cargo's naming, not ours).
const MEMSRV_BIN = path.join(REPO_ROOT, "memory-layer", "target", "debug",
  process.platform === "win32" ? "memsrv.exe" : "memsrv");

test("list_skills indexes each discovered bundle once, never duplicates, recallable by purpose", async () => {
  const tmp = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "sea-disc-wire-"));
  const projRoot = path.join(tmp, "proj");
  const bundleDir = path.join(projRoot, ".agents", "skills", "flake-finder");
  const fsp = await import("node:fs/promises");
  await fsp.mkdir(bundleDir, { recursive: true });
  await fsp.writeFile(path.join(bundleDir, "manifest.json"), JSON.stringify({
    name: "flake-finder",
    version: "1.0.0",
    description: "find and rerun a flaky test in the repo",
    tools: ["find_flake"],
  }));

  const journal = path.join(tmp, "disc-journal.jsonl");
  const prevJournal = process.env.MNEMO_MEMORY_JOURNAL;
  const prevBin = process.env.MNEMO_MEMSRV_BIN;
  process.env.MNEMO_MEMORY_JOURNAL = journal;
  process.env.MNEMO_MEMSRV_BIN = MEMSRV_BIN;

  try {
    // first imports in this process happen AFTER env is set, so the shared
    // memory client (used by list_skills) binds to the temp journal
    const { listSkillsTool, setProjectRoot, setSkillsHome } = await import("../src/tools/skills.ts");
    const { MemClient } = await import("../extensions/memory-layer.ts");
    setProjectRoot(projRoot);
    setSkillsHome(tmp);
    const verify = new MemClient(); // same env -> same journal as the sidecar list_skills spawns
    try {
      await listSkillsTool.execute("d1", {});
      const once = await verify.request("dump");
      const harnesses = once.result.nodes.filter(
        (n: any) => n.kind === "Harness" && n.label === "flake-finder",
      );
      assert.equal(harnesses.length, 1, "first discovery indexes the bundle once");

      await listSkillsTool.execute("d2", {});
      const twice = await verify.request("dump");
      const after = twice.result.nodes.filter(
        (n: any) => n.kind === "Harness" && n.label === "flake-finder",
      );
      assert.equal(after.length, 1, "second discovery reuses the node, no duplicate");

      const hit = await verify.request("search", { query: "find a flaky test", k: 3 });
      const labels = hit.result.results.map((r: any) => r.label);
      assert.ok(labels.includes("flake-finder"),
        `harness must be recallable by purpose, got: ${labels.join(", ")}`);

      const state = await verify.request("state", { node: harnesses[0].id });
      assert.match(String(state.result.state), /find and rerun a flaky test/);
    } finally {
      verify.stop();
      // list_skills indexed through the module-level shared client; stop its
      // sidecar too or the suite never exits (memsrv keeps the loop alive)
      (await import("../extensions/memory-layer.ts")).sharedMem.stop();
    }
  } finally {
    if (prevJournal === undefined) delete process.env.MNEMO_MEMORY_JOURNAL;
    else process.env.MNEMO_MEMORY_JOURNAL = prevJournal;
    if (prevBin === undefined) delete process.env.MNEMO_MEMSRV_BIN;
    else process.env.MNEMO_MEMSRV_BIN = prevBin;
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});