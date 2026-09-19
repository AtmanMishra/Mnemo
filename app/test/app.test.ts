/**
 * The application, exercised as a program and as a unit.
 *
 * The app's runtime is Bun, so the tests ask Bun to run it — even when the suite
 * itself is on Node. When no Bun is on the machine they say so and skip rather
 * than pretending: a green suite that never ran the entry is the failure mode
 * this file exists to avoid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { collectFacts, mnemoHome, readProviders } from "../src/facts.ts";

const entry = fileURLToPath(new URL("../bin/mnemo.ts", import.meta.url));

function bunBin(): string | null {
  const explicit = process.env.MNEMO_BUN?.trim();
  for (const candidate of explicit ? [explicit] : ["bun"]) {
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
if (!bun) console.log("# no Bun on PATH — the entry tests are skipped, not passed");

/** A run from a directory that has never seen Mnemo. */
function run(args: string[], files: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-app-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, name), content);
  }
  const result = spawnSync(bun!, [entry, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, MNEMO_HOME: home, PI_CODING_AGENT_DIR: path.join(dir, "pi") },
  });
  return { dir, home, result };
}

test("--dump renders the first frame with nothing configured", { skip: !bun }, () => {
  const { dir, home, result } = run(["--dump", "--rows", "24", "--cols", "96"]);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MNEMO/);
    assert.match(result.stdout, /Bun \d/, "the runtime is stated, not implied");
    assert.match(result.stdout, /\/login/, "a machine with nothing configured is told the first step");
    assert.match(result.stdout, /\/model/);
    assert.ok(
      result.stdout.split("\n").every((l) => l.length <= 96),
      "no line may exceed the width it was given",
    );
    assert.deepEqual(fs.readdirSync(home), [], "rendering a frame is a read");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--dump shows the configured provider instead of onboarding", { skip: !bun }, () => {
  const { dir, result } = run(["--dump"], {
    "auth.json": JSON.stringify({
      version: 1,
      providers: { openrouter: { key: "sk-or-…", defaultModel: "deepseek-v4" } },
      defaultProvider: "openrouter",
    }),
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ready\. openrouter {2}· {2}deepseek-v4/);
    assert.doesNotMatch(result.stdout, /nothing is set up/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor fails for the right reason and names the fix", { skip: !bun }, () => {
  const { dir, result } = run(["doctor"]);
  try {
    assert.equal(result.status, 1, "nothing can run a model without a provider");
    assert.match(result.stdout, /mnemo doctor/);
    assert.match(result.stdout, /FAIL {2}provider/);
    assert.match(result.stdout, /fix: .*\/login/);
    assert.match(result.stdout, /warn {2}memory sidecar/, "an off feature is a warning, not a failure");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--version and --help need no home, no key and no model", { skip: !bun }, () => {
  const version = run(["--version"]);
  try {
    assert.equal(version.result.status, 0, version.result.stderr);
    assert.match(version.result.stdout, /^mnemo \d+\.\d+\.\d+ — bun \d/);
  } finally {
    fs.rmSync(version.dir, { recursive: true, force: true });
  }

  const help = run(["--help"]);
  try {
    assert.equal(help.result.status, 0, help.result.stderr);
    assert.match(help.result.stdout, /--dump/);
    assert.match(help.result.stdout, /doctor/);
  } finally {
    fs.rmSync(help.dir, { recursive: true, force: true });
  }
});

test("an unknown command says so instead of starting something", { skip: !bun }, () => {
  const { dir, result } = run(["frobnicate"]);
  try {
    assert.equal(result.status, 2);
    assert.match(result.stderr, /mnemo — a terminal coding agent/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("facts come from the injected sources, never the developer's real home", () => {
  // Built with path.join, because that is what the code under test uses to
  // reach the file: a literal "/h/auth.json" would never match on Windows.
  const home = path.join(path.sep, "h");
  const authPath = path.join(home, "auth.json");
  const pythonPath = path.join(path.sep, "usr", "bin", process.platform === "win32" ? "python.exe" : "python3");
  // The sidecar is named per platform — the same rule the code applies, so the
  // fixture cannot disagree with it on one of the two platforms.
  const memsrvPath = path.join(home, process.platform === "win32" ? "memsrv.exe" : "memsrv");
  const files: Record<string, string> = {
    [authPath]: JSON.stringify({
      version: 1,
      providers: {
        openrouter: { key: "k", defaultModel: "m-1" },
        empty: {},
      },
      defaultProvider: "openrouter",
    }),
  };
  const facts = collectFacts({
    env: { MNEMO_HOME: home },
    exists: (p) => p === memsrvPath || p === pythonPath,
    readFile: (p) => files[p] ?? (() => { throw new Error("ENOENT"); })(),
    which: (cmd) => (cmd === "python3" ? pythonPath : null),
    runtime: "Bun 1.3.14",
  });

  assert.equal(facts.home, home);
  assert.equal(facts.provider, "openrouter", "a provider with a key");
  assert.equal(facts.model, "m-1", "the default model, from the store's shape");
  assert.equal(facts.memory, true);
  assert.equal(facts.kernel, true, "an interpreter that exists");
  assert.equal(facts.runtime, "Bun 1.3.14");
});

test("a broke, empty or absent store is no provider — never a crash", () => {
  const home = (letter: string) => path.join(path.sep, letter);
  const cases: Record<string, string> = {
    [home("a")]: "{not json",
    [home("b")]: "{}",
    // A whitespace-only key is not a credential: it is a paste that went wrong.
    [home("c")]: JSON.stringify({ providers: { x: {}, y: { key: "  " } } }),
  };
  for (const [dir, content] of Object.entries(cases)) {
    const { providers } = readProviders(dir, () => content);
    assert.deepEqual(providers, [], `${dir} must read as no provider`);
  }
  const absent = readProviders(home("z"), () => {
    throw new Error("ENOENT");
  });
  assert.deepEqual(absent.providers, []);
});

test("mnemoHome honours the override and trims it", () => {
  assert.equal(mnemoHome({ MNEMO_HOME: " /custom " }), "/custom");
  assert.match(mnemoHome({}), /\.mnemo$/);
});
