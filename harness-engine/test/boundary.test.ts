/**
 * Issue #7 — the execution boundary. These tests assert the PROPERTIES the
 * documentation claims, so "the boundary" cannot quietly become a word:
 *
 *   1. env scrubbing  — a secret in the host's env is NOT in the child's env
 *   2. cwd jail       — the child runs in the bundle dir, not the host's cwd
 *   3. no host import — the bundle's module top-level runs in ANOTHER process
 *   4. timeout kill   — a hanging bundle dies at the wall clock, tree included
 *   5. bounded output — a stdout flood cannot exhaust the host or lose the
 *                       bundle's verdict
 *   6. honest failure — a non-zero exit reports what the bundle SAID
 *   7. gate ordering  — the lexical gate still runs BEFORE any spawn
 *   8. escalation     — an ignored polite signal becomes SIGKILL / taskkill /F
 *
 * Assertions 1-3 need the bundle to observe its own process, and the gate blocks
 * `process` by design — so those fixtures pass `allowModules: ["node:process"]`
 * and import `node:process` under an ALIAS (the gate's `process` regex does not
 * match a renamed binding). That is the gate working as documented, not a hole:
 * it is exactly the "unless allowlisted" clause.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { loadBundle } from "../src/bundle.ts";
import { createHarness } from "../src/create-harness.ts";
import { ToolRegistry } from "../src/registry.ts";
import {
  DEFAULT_ENV_ALLOWLIST,
  runInChild,
  scrubChildEnv,
  terminateChildTree,
  type KillSystem,
  type TearDownTarget,
} from "../src/boundary.ts";
import { makeTmpDir, rmTree, writeBundleDir } from "./helpers.ts";

/** Modules the probe fixtures need; the gate allows these explicitly. */
const PROBE_MODULES = ["node:process", "node:fs"];

/** One tool file that may inspect the process it is running in. */
function probeModule(name: string, body: string, topLevel = ""): string {
  return [
    `import proc from "node:process";`,
    `import { writeFileSync } from "node:fs";`,
    topLevel,
    `const schema = { type: "object", properties: {}, required: [] };`,
    `export default {`,
    `  name: ${JSON.stringify(name)},`,
    `  description: "probe",`,
    `  schema,`,
    `  async execute(params) {`,
    body,
    `  },`,
    `};`,
    ``,
  ].join("\n");
}

async function tmpRoot(): Promise<string> {
  return makeTmpDir("harness-boundary-");
}

// ── 1. env scrubbing ─────────────────────────────────────────────────────────

test("scrubChildEnv passes ONLY allowlisted names", () => {
  const out = scrubChildEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-openai-secret",
      GITHUB_TOKEN: "ghp_secret",
      DB_PASSWORD: "hunter2",
      AWS_SECRET_ACCESS_KEY: "wJalr",
      NODE_OPTIONS: "--require ./evil.js",
      MNEMO_UNLISTED: "value the child has no business seeing",
    } as NodeJS.ProcessEnv,
    ["PATH", "HOME", "ANTHROPIC_API_KEY", "NODE_OPTIONS"] as const,
  );
  assert.deepEqual(Object.keys(out.env).sort(), ["HOME", "PATH"]);
  assert.equal(out.env.PATH, "/usr/bin");
  // Credential-shaped AND interpreter-injection names are refused even when the
  // caller allowlists one — the allowlist decides what a bundle may KNOW, never
  // what it may load.
  assert.deepEqual(out.refused.sort(), ["ANTHROPIC_API_KEY", "NODE_OPTIONS"]);
});

test("the default allowlist carries no interpreter-injection variable", () => {
  // NODE_OPTIONS/NODE_PATH can make the child run arbitrary code before the
  // bundle: a boundary that inherits them is not a boundary.
  assert.ok(!DEFAULT_ENV_ALLOWLIST.includes("NODE_OPTIONS"));
  assert.ok(!DEFAULT_ENV_ALLOWLIST.includes("NODE_PATH"));
  const env = scrubChildEnv({ PATH: "/bin", NODE_OPTIONS: "--require /tmp/x.js" } as NodeJS.ProcessEnv);
  assert.deepEqual(Object.keys(env.env), ["PATH"]);
});

test("a secret in the host's env does not reach the boundary child", async () => {
  const names = ["MNEMO_UNLISTED_VALUE", "MNEMO_TEST_SECRET_TOKEN"];
  const saved = names.map((n) => [n, process.env[n]] as const);
  process.env.MNEMO_UNLISTED_VALUE = "plain-named secret";
  process.env.MNEMO_TEST_SECRET_TOKEN = "credential-shaped secret";
  const root = await tmpRoot();
  try {
    const dir = await writeBundleDir(root, "env-probe", [
      {
        name: "peek",
        source: probeModule(
          "peek",
          [
            `    const seen = ["MNEMO_UNLISTED_VALUE", "MNEMO_TEST_SECRET_TOKEN"]`,
            `      .filter((k) => proc.env[k] !== undefined);`,
            `    return seen.length === 0 ? "ABSENT" : "LEAKED:" + seen.join(",");`,
          ].join("\n"),
        ),
      },
    ]);
    const bundle = await loadBundle(dir, null, {
      execution: "child",
      allowModules: PROBE_MODULES,
    });
    assert.equal(
      await bundle.tools.get("peek")!.execute({}),
      "ABSENT",
      "the child must not see the host's secret at all",
    );

    // The child attests to its own env NAMES, so the claim does not rest on the
    // host's own scrubbing code — and PATH is there, proving it is a real env.
    const run = await runInChild({
      mode: "execute",
      dir,
      refs: ["tools/peek.mjs"],
      tool: "peek",
      params: {},
      allowModules: PROBE_MODULES,
    });
    assert.equal(run.status, "ok");
    assert.ok(run.childEnvNames.includes("PATH"), "the child should still have PATH");
    for (const n of names) {
      assert.ok(!run.childEnvNames.includes(n), `${n} reached the child: ${run.childEnvNames.join(",")}`);
    }
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    await rmTree(root);
  }
});

// ── 2 + 3. cwd jail, and the host never importing the bundle ─────────────────

test("the bundle's module runs in a CHILD whose cwd is the bundle dir", async () => {
  const root = await tmpRoot();
  const hostCwd = process.cwd();
  const hostPid = process.pid;
  try {
    // Top-level side effect: proves the import happened somewhere, and records
    // WHERE. A RELATIVE write proves the cwd at import time.
    const dir = await writeBundleDir(root, "marker-bundle", [
      {
        name: "marker",
        source: probeModule(
          "marker",
          `    return proc.cwd() + "\\n" + proc.pid;`,
          `writeFileSync("loaded-marker.txt", proc.pid + ":" + proc.cwd(), "utf8");`,
        ),
      },
    ]);
    assert.notEqual(path.resolve(dir), hostCwd, "the fixture must not BE the host cwd");

    const bundle = await loadBundle(dir, null, { execution: "child", allowModules: PROBE_MODULES });
    assert.equal(bundle.execution, "child");
    const out = await bundle.tools.get("marker")!.execute({});
    const [childCwd, childPid] = out.split("\n");

    // cwd jail: the child's cwd is the (realpath'd) bundle dir, not the host's.
    const realDir = await fs.realpath(dir);
    assert.equal(childCwd, realDir);
    assert.notEqual(childCwd, hostCwd);
    // The WHOLE POINT: the module was evaluated in another process.
    assert.notEqual(childPid, String(hostPid));
    // And the top-level side effect landed in the bundle dir, because that was
    // the cwd when the module loaded — not in the agent's project root.
    const marker = await fs.readFile(path.join(dir, "loaded-marker.txt"), "utf8");
    assert.equal(marker, `${childPid}:${realDir}`);
  } finally {
    await rmTree(root);
  }
});

// ── 4. timeout, tree kill ────────────────────────────────────────────────────

test("a bundle that loops forever is killed at the wall clock, and its PID is gone", async () => {
  const root = await tmpRoot();
  try {
    const dir = await writeBundleDir(root, "spinner", [
      { name: "spin", source: probeModule("spin", `    while (true) { /* never returns */ }`) },
    ]);
    const bundle = await loadBundle(dir, null, {
      execution: "child",
      allowModules: PROBE_MODULES,
      boundary: { timeoutMs: 1200, graceMs: 300 },
    });
    await assert.rejects(
      () => bundle.tools.get("spin")!.execute({}),
      (err: Error) => /exceeded the 1200ms wall-clock limit/.test(err.message),
    );

    // Same thing at the boundary level, where the pid and the termination report
    // are visible: the child is really gone afterwards, not merely abandoned.
    const run = await runInChild(
      { mode: "execute", dir, refs: ["tools/spin.mjs"], tool: "spin", params: {}, allowModules: PROBE_MODULES },
      { timeoutMs: 900, graceMs: 300 },
    );
    assert.equal(run.status, "timeout");
    assert.equal(run.timedOut, true);
    assert.ok(run.termination, "a timeout must report how the tree was ended");
    assert.match(run.termination!.method, /SIGTERM|SIGKILL|taskkill/);
    assert.ok(run.pid, "the child had a pid");
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(
      () => process.kill(run.pid!, 0),
      "the killed bundle process must actually be gone (ESRCH)",
    );
  } finally {
    await rmTree(root);
  }
});

test("an ignored graceful signal escalates to SIGKILL / taskkill /T /F", async () => {
  // The grace timer is unref'd on purpose (a wedged bundle must not hold the
  // agent's event loop open), so a bare test loop has to hold a handle of its
  // own for the escalation to be observable — same discipline as the mcp
  // teardown tests.
  const keepLoopAlive = (): (() => void) => {
    const handle = setInterval(() => { /* a live event loop */ }, 5);
    return () => clearInterval(handle);
  };
  // Same discipline as the mcp teardown tests: an injectable kill system, so no
  // real tree is ever signalled — and the platform path is chosen, not raced.
  const runEscalation = async (platform: NodeJS.Platform): Promise<string[]> => {
    const actions: string[] = [];
    const kill: KillSystem = {
      platform,
      signal: (_pid, s) => void actions.push(s),
      taskkill: (_pid, force) => void actions.push(force ? "taskkill /T /F" : "taskkill /T"),
    };
    // A tree that ignores the polite signal and stays alive: the worst case.
    const stubborn: TearDownTarget = {
      pid: 4242,
      alive: () => true,
      onExit: () => { /* never ends on its own */ },
      kill: () => true,
    };
    const stop = keepLoopAlive();
    try {
      const report = await terminateChildTree(stubborn, { graceMs: 20, kill });
      assert.equal(report.escalated, true);
      assert.equal(report.pid, 4242);
    } finally {
      stop();
    }
    return actions;
  };

  assert.deepEqual(await runEscalation("win32"), ["taskkill /T", "taskkill /T /F"]);
  assert.deepEqual(await runEscalation("linux"), ["SIGTERM", "SIGKILL"]);

  // A tree that dies on the graceful signal is NOT escalated, and says so.
  const actions: string[] = [];
  let signalled = false;
  const listeners: Array<() => void> = [];
  const kill: KillSystem = {
    platform: "linux",
    signal: (_pid, s) => {
      actions.push(s);
      signalled = true;
      queueMicrotask(() => listeners.forEach((l) => l()));
    },
  };
  const obedient: TearDownTarget = {
    pid: 7,
    alive: () => !signalled,
    onExit: (listener) => listeners.push(listener),
    kill: () => true,
  };
  const report = await terminateChildTree(obedient, { graceMs: 50, kill });
  assert.deepEqual(actions, ["SIGTERM"], "one polite signal, nothing more");
  assert.deepEqual(report, { escalated: false, method: "SIGTERM", graceMs: 50, pid: 7 });
});

// ── 5. bounded output ────────────────────────────────────────────────────────

test("a stdout flood is bounded, and cannot destroy the bundle's verdict", async () => {
  const root = await tmpRoot();
  try {
    const dir = await writeBundleDir(root, "flooder", [
      {
        name: "flood",
        source: [
          `const schema = { type: "object", properties: {} };`,
          `export default {`,
          `  name: "flood",`,
          `  schema,`,
          `  async execute() {`,
          `    for (let i = 0; i < 20000; i++) console.log("line " + i + " ".repeat(40));`,
          `    return "survived the flood";`,
          `  },`,
          `};`,
          ``,
        ].join("\n"),
      },
    ]);
    const bundle = await loadBundle(dir, null, {
      execution: "child",
      boundary: { maxOutputBytes: 4096 },
    });
    // The verdict survives because it travels in the result file, not on stdout.
    assert.equal(await bundle.tools.get("flood")!.execute({}), "survived the flood");

    const run = await runInChild(
      { mode: "execute", dir, refs: ["tools/flood.mjs"], tool: "flood", params: {} },
      { maxOutputBytes: 4096 },
    );
    assert.equal(run.status, "ok");
    assert.equal(run.truncated.stdout, true, "the host must SAY it truncated");
    assert.ok(run.stdout.length <= 4096, `kept ${run.stdout.length} bytes, cap was 4096`);
    assert.ok(run.stdoutBytes > 4096, "the byte count still reflects what the bundle produced");
  } finally {
    await rmTree(root);
  }
});

// ── 6. honest failure ────────────────────────────────────────────────────────

test("a failing bundle reports what it SAID, not just 'failed'", async () => {
  const root = await tmpRoot();
  try {
    const dir = await writeBundleDir(root, "failing", [
      {
        name: "boom",
        source: [
          `const schema = { type: "object", properties: {} };`,
          `export default {`,
          `  name: "boom",`,
          `  schema,`,
          `  async execute() {`,
          `    console.log("stdout line before the throw");`,
          `    console.error("stderr line: no config at /etc/thing");`,
          `    throw new Error("boom: the bundle gave up");`,
          `  },`,
          `};`,
          ``,
        ].join("\n"),
      },
    ]);
    const bundle = await loadBundle(dir, null, { execution: "child" });
    await assert.rejects(
      () => bundle.tools.get("boom")!.execute({}),
      (err: Error) => {
        assert.match(err.message, /boom: the bundle gave up/, "the thrown message is reported");
        assert.match(err.message, /stderr line: no config/, "what the bundle printed to stderr is reported");
        assert.match(err.message, /stdout line before the throw/, "stdout too, bounded");
        assert.match(err.message, /exited 1/, "and the non-zero exit is named");
        return true;
      },
    );

    const run = await runInChild(
      { mode: "execute", dir, refs: ["tools/boom.mjs"], tool: "boom", params: {} },
    );
    assert.equal(run.status, "failed");
    assert.equal(run.exitCode, 1, "a failed bundle exits non-zero");
    assert.match(run.response!.error!, /boom: the bundle gave up/);
  } finally {
    await rmTree(root);
  }
});

// ── 7. gate ordering, and interpreter failures ───────────────────────────────

test("the lexical gate still runs BEFORE any spawn", async () => {
  const root = await tmpRoot();
  try {
    const dir = await writeBundleDir(root, "evil-child", [{ name: "boom" }]);
    await fs.writeFile(
      path.join(dir, "tools", "boom.mjs"),
      `import { execSync } from "node:child_process";\n` +
        `export default { name: "boom", schema: { type: "object" }, async execute(p) { return execSync(p.cmd).toString(); } };\n`,
      "utf8",
    );
    // nodePath is a binary that cannot exist: if the gate ran first, the refusal
    // is a gate refusal and no process was ever started.
    await assert.rejects(
      () => loadBundle(dir, null, { execution: "child", boundary: { nodePath: "no-such-node-binary-xyz" } }),
      /rejected by safety gate.*child_process/,
    );
  } finally {
    await rmTree(root);
  }
});

test("a missing interpreter is a boundary error, not a silent 'no result'", async () => {
  const root = await tmpRoot();
  try {
    const dir = await writeBundleDir(root, "fine", [{ name: "ok" }]);
    const run = await runInChild(
      { mode: "describe", dir, refs: ["tools/ok.mjs"] },
      { nodePath: "no-such-node-binary-xyz" },
    );
    assert.equal(run.status, "spawn-error");
    assert.match(run.error!, /could not spawn the bundle child/);
  } finally {
    await rmTree(root);
  }
});

// ── blast radius: the child dies, the host does not ──────────────────────────

test("a bundle that kills its own process cannot take the host with it", async () => {
  const root = await tmpRoot();
  const hostPid = process.pid;
  try {
    const dir = await writeBundleDir(root, "selfkill", [
      { name: "suicide", source: probeModule("suicide", `    proc.exit(3);`) },
    ]);
    const bundle = await loadBundle(dir, null, { execution: "child", allowModules: PROBE_MODULES });
    await assert.rejects(
      () => bundle.tools.get("suicide")!.execute({}),
      (err: Error) => {
        assert.match(err.message, /exited 3/, "the exit code is reported");
        assert.match(err.message, /said nothing before it stopped/, "and the silence is reported too");
        return true;
      },
    );

    const run = await runInChild(
      { mode: "execute", dir, refs: ["tools/suicide.mjs"], tool: "suicide", params: {}, allowModules: PROBE_MODULES },
    );
    assert.equal(run.status, "failed");
    assert.equal(run.exitCode, 3);
    assert.match(run.error!, /no result frame/);

    // The host is still here, and still able to run a bundle: the whole claim.
    assert.equal(process.pid, hostPid);
    const ok = await writeBundleDir(root, "still-here", [{ name: "alive" }]);
    const okBundle = await loadBundle(ok, null, { execution: "child" });
    assert.equal(await okBundle.tools.get("alive")!.execute({}), "ran:still-here:alive");
  } finally {
    await rmTree(root);
  }
});

// ── defaults: where the boundary lives, and where it does not ────────────────

test("createHarness defaults to the boundary; loadBundle's own default is explicit", async () => {
  const root = await tmpRoot();
  try {
    // loadBundle's bare default stays in-process (metadata paths should not pay
    // for a spawn) — and it SAYS so, so a caller can never be unsure.
    const onDisk = await writeBundleDir(root, "disk-bundle", [{ name: "greet" }]);
    const plain = await loadBundle(onDisk);
    assert.equal(plain.execution, "in-process");

    // The self-extension seam — the path the model's own code takes — is bounded
    // by default, and reports it.
    const registry = new ToolRegistry();
    const created = await createHarness({
      registry,
      root,
      spec: {
        name: "seam-bundle",
        description: "created through the seam",
        tools: [{ name: "hello", schema: { type: "object", properties: {} }, source: 'return "hello";' }],
      },
    });
    assert.equal(created.execution, "child");
    const found = registry.resolve("hello");
    assert.ok(found, "the created tool is registered");
    assert.equal(await found!.tool.execute({}), "hello", "and it runs — in the child");
    assert.equal(found!.bundle.execution, "child");

    // The opt-out exists, is explicit, and is visible in the result.
    const downgraded = await createHarness({
      registry: new ToolRegistry(),
      root,
      execution: "in-process",
      spec: {
        name: "downgraded",
        description: "explicitly in-process",
        tools: [{ name: "hello2", schema: { type: "object", properties: {} }, source: 'return "downgraded";' }],
      },
    });
    assert.equal(downgraded.execution, "in-process");
    await downgraded.disposable.dispose();
  } finally {
    await rmTree(root);
  }
});
