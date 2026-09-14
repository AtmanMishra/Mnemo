/**
 * B3: MNEMO_CONSOLIDATE_THRESHOLD tunes how many NEW episodes force a
 * shutdown consolidation, without a rebuild. The value is read once at
 * startup (module load), so every case here runs the import in a FRESH child
 * process — that is the only way to observe "read at startup" from a test
 * runner that shares one process per file.
 *
 * The default is 3; anything that is not a positive integer keeps it. Do not
 * confuse this knob with the memory layer's MIN_SOURCES_FOR_THEME
 * (MNEMO_MIN_OCCURRENCES, memory-layer/src/consolidate.rs) — that one decides
 * what counts as a recurring theme inside one pass.
 */
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";

/** Load the extension in a child process with the given override and read the constant. */
function thresholdWith(raw: string | undefined): number {
  const url = new URL("../extensions/memory-layer.ts", import.meta.url).href;
  const script = `import(${JSON.stringify(url)}).then((m) => console.log(m.CONSOLIDATE_EVERY_N_EPISODES))`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MNEMO_CONSOLIDATE_THRESHOLD;
  if (raw !== undefined) env.MNEMO_CONSOLIDATE_THRESHOLD = raw;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
  });
  const lines = out.trim().split(/\r?\n/);
  return Number(lines[lines.length - 1]);
}

test("MNEMO_CONSOLIDATE_THRESHOLD overrides the episode threshold", () => {
  assert.equal(thresholdWith("7"), 7);
  assert.equal(thresholdWith("12"), 12);
});

test("an absent or malformed override keeps the built-in default of 3", () => {
  assert.equal(thresholdWith(undefined), 3);
  assert.equal(thresholdWith(""), 3);
  assert.equal(thresholdWith("0"), 3, "zero would mean 'never consolidate' by accident");
  assert.equal(thresholdWith("-4"), 3);
  assert.equal(thresholdWith("junk"), 3);
});
