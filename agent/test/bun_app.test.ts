/**
 * The Bun entry, exercised as a program.
 *
 * The app's runtime is Bun, so the test asks Bun to run it — even when the
 * suite itself is running on Node. When no Bun is on the machine the test says
 * so and skips rather than pretending: a green suite that never ran the entry
 * is the failure mode this file exists to avoid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../bin/mnemo-bun.ts", import.meta.url));

/** A Bun that actually runs, or null with the reason printed. */
function bunBin(): string | null {
  const explicit = process.env.MNEMO_BUN?.trim();
  const candidates = explicit ? [explicit] : ["bun"];
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 15_000 });
      if (probe.status === 0 && (probe.stdout ?? "").trim() !== "") return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const bun = bunBin();
if (!bun) console.log("# no Bun on PATH — the Bun entry tests are skipped, not passed");

/** A run from a directory that has never seen Mnemo. */
function run(args: string[], env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-bun-"));
  const result = spawnSync(bun!, [entry, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      MNEMO_HOME: path.join(dir, "home"),
      PI_CODING_AGENT_DIR: path.join(dir, "pi"),
      ...env,
    },
  });
  return { dir, result };
}

test("--dump renders the first frame with no model, no key and no agent", { skip: !bun }, () => {
  const { dir, result } = run(["--dump", "--rows", "24", "--cols", "96"]);
  try {
    assert.equal(result.status, 0, result.stderr);
    const frame = result.stdout;
    assert.match(frame, /MNEMO/, "it is Mnemo's screen");
    assert.match(frame, /Bun \d/, "the runtime is stated, not implied");
    assert.match(frame, /\/login/, "a machine with nothing configured is told the first step");
    assert.match(frame, /\/model/, "and the second");
    assert.ok(
      frame.split("\n").every((l) => l.length <= 96),
      "no line may exceed the width it was given",
    );
    // Rendering a frame is a read: it must not create config, sessions or
    // journals. A home that was never created is the strongest form of that.
    const home = path.join(dir, "home");
    // Read once, outside the assertion: an assert message is evaluated
    // eagerly, so a readdir in the message throws before a passing assertion
    // can pass (it did, on the first run of this test).
    const created = fs.existsSync(home) ? fs.readdirSync(home, { recursive: true }) : [];
    assert.deepEqual(created, [], `--dump created state in ${home}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor on an empty home fails for the right reason and names the fix", { skip: !bun }, () => {
  const { dir, result } = run(["doctor"]);
  try {
    assert.equal(result.status, 1, "nothing can run a model without a provider");
    assert.match(result.stdout, /mnemo doctor/);
    assert.match(result.stdout, /FAIL {2}provider/);
    assert.match(result.stdout, /fix: .*\/login/, "a failure must carry the command that fixes it");
    // The optional pieces are reported as warnings, not failures.
    assert.match(result.stdout, /warn {2}memory sidecar/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--version and --help answer without a home, a key or a model", { skip: !bun }, () => {
  const version = run(["--version"]);
  try {
    assert.equal(version.result.status, 0, version.result.stderr);
    assert.match(version.result.stdout, /mnemo dev/);
    assert.match(version.result.stdout, /bun \d/, "the version line says which runtime this is");
  } finally {
    fs.rmSync(version.dir, { recursive: true, force: true });
  }

  const help = run(["--help"]);
  try {
    assert.equal(help.result.status, 0, help.result.stderr);
    assert.match(help.result.stdout, /doctor/);
    assert.match(help.result.stdout, /--dump/);
  } finally {
    fs.rmSync(help.dir, { recursive: true, force: true });
  }
});
