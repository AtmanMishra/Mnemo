/**
 * The Bun application's own units: the runtime floor, the diagnosis, and the
 * frame a first run sees.
 *
 * These are the three things a person meets before the model does — the runtime
 * it needs, the answer to "why is this not working", and the screen that says
 * what to do next — so they are tested before they are written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_BUN, checkBunVersion, isSupportedBun } from "../src/runtime_check.ts";
import { doctorLines, doctorExitCode, probesOf } from "../src/app/doctor.ts";
import { renderBootFrame } from "../src/app/frame.ts";

test("the Bun floor is a version with a message that names the fix", () => {
  assert.equal(isSupportedBun(`1.${MIN_BUN.minor}.0`), true, "the floor itself is supported");
  assert.equal(isSupportedBun("1.2.20"), false, "below the minor floor");
  assert.equal(isSupportedBun("0.9.0"), false, "major below");
  assert.equal(isSupportedBun("2.0.0"), true, "a newer major is fine");
  assert.equal(isSupportedBun("not-a-version"), true, "unreadable is not proof of old");
  assert.equal(checkBunVersion(`1.${MIN_BUN.minor}.0`), null);
  const msg = checkBunVersion("1.1.0")!;
  assert.match(msg, /1\.1\.0/, "names what is running");
  assert.match(msg, /bun upgrade|bun\.sh/, "gives a command to run");
});

test("doctor says what is wrong, names the fix, and separates required from optional", () => {
  const lines = doctorLines({
    runtime: "Bun 1.3.14",
    home: "/home/u/.mnemo",
    homeWritable: true,
    providers: ["openrouter"],
    model: "deepseek-v4",
    memsrv: { path: "/home/u/.mnemo/memsrv", exists: false },
    kernel: { path: "", exists: false },
    agent: { script: "/repo/agent/bin/mnemo.ts", exists: true },
  });
  const text = lines.map((l) => l.text).join("\n");

  assert.match(text, /Bun 1\.3\.14/, "the runtime it is running on");
  assert.match(text, /openrouter/, "the provider actually configured");

  const memory = lines.find((l) => l.name === "memory sidecar")!;
  assert.equal(memory.ok, false);
  assert.equal(memory.required, false, "no sidecar turns a feature off, it is not a broken install");
  assert.ok(memory.fix && memory.fix.length > 0, "a failure must carry the line that fixes it");

  // The invariant the whole diagnosis rests on: nothing fails without a remedy.
  for (const line of lines.filter((l) => !l.ok)) {
    assert.ok(line.fix && line.fix.trim().length > 0, `${line.name} failed with no fix`);
  }
});

test("doctor exits non-zero only when something required is missing", () => {
  const base = {
    runtime: "Bun 1.3.14", home: "/h/.mnemo", homeWritable: true,
    providers: ["openrouter"], model: "m",
    memsrv: { path: "/h/.mnemo/memsrv", exists: false },
    kernel: { path: "", exists: false },
    agent: { script: "/repo/agent/bin/mnemo.ts", exists: true },
  };
  assert.equal(doctorExitCode(doctorLines(base)), 0, "an off feature is not a failure");

  const noProvider = doctorLines({ ...base, providers: [], model: "" });
  assert.equal(doctorExitCode(noProvider), 1, "nothing can run a model without a provider");

  const unwritable = doctorLines({ ...base, homeWritable: false });
  assert.equal(doctorExitCode(unwritable), 1, "a home it cannot write to is a broken install");
});

test("probesOf reads the machine, and reports what it cannot know rather than guessing", () => {
  const probes = probesOf({
    env: { MNEMO_HOME: "/tmp/mnemo-test-home" },
    exists: () => false,
    providers: () => ["anthropic"],
    model: () => "claude-x",
    runtime: "Bun 1.3.14",
    repoRoot: "/repo",
  });
  assert.equal(probes.home, "/tmp/mnemo-test-home", "MNEMO_HOME wins, as it does everywhere else");
  assert.equal(probes.homeWritable, false, "a directory that does not exist is not writable");
  assert.deepEqual(probes.providers, ["anthropic"]);
});

test("the boot frame says what to do, and what it is running on", () => {
  const frame = renderBootFrame({
    rows: 24, cols: 96, runtime: "Bun 1.3.14", home: "/home/u/.mnemo",
    provider: undefined, memsrv: false, kernel: false,
  });
  assert.match(frame, /MNEMO/, "it is Mnemo's screen");
  assert.match(frame, /Bun 1\.3\.14/, "the runtime is stated, not implied");
  assert.match(frame, /\/login/, "the first step has a command");
  assert.match(frame, /\/model/, "the second step has a command");
  assert.ok(
    frame.split("\n").every((l) => l.length <= 96),
    "no line may exceed the width it was given",
  );

  const configured = renderBootFrame({
    rows: 24, cols: 96, runtime: "Bun 1.3.14", home: "/home/u/.mnemo",
    provider: "openrouter", model: "deepseek-v4", memsrv: true, kernel: true,
  });
  assert.match(configured, /openrouter/, "a configured provider is shown, not a setup list");
  assert.ok(!/nothing is set up/i.test(configured), "no onboarding for a machine already set up");
});
