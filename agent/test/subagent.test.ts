import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { composeChildPrompt, extractAnswer, runSubagent, childMemoryEnv, subagentSpawnTool,
  DEFAULT_SUBAGENT_MAX_DEPTH, SUBAGENT_DEPTH_ENV, SUBAGENT_MAX_DEPTH_ENV,
  subagentDepth, subagentDepthRefusal, subagentMaxDepth } from "../src/tools/subagent.ts";
import { textOf } from "../src/tools/types.ts";

describe("spawn_subagent", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "sea-subagent-"));
  const fakeCli = path.join(tmp, "fake-agent.mjs");
  // fake child CLI: prints ANSWER line; echoes received env/prompt via file
  const received = path.join(tmp, "received.json");
  writeFileSync(fakeCli, `
    import { writeFileSync } from "node:fs";
    const prompt = process.argv[2] ?? "";
    writeFileSync(${JSON.stringify(received)}, JSON.stringify({
      prompt, journal: process.env.SEA_MEMORY_JOURNAL ?? null,
      model: process.env.SEA_MODEL ?? null,
    }));
    console.log("working...");
    console.log("ANSWER: child-final-answer");
  `);

  test("composes brief-style prompt with task + context", () => {
    const p = composeChildPrompt("fix the flaky test", "repo uses vitest; bug is in timer mock");
    assert.ok(p.includes("TASK: fix the flaky test"));
    assert.ok(p.includes("CONTEXT FROM PARENT"));
    assert.ok(p.includes("timer mock"));
    // no context -> no context section
    const p2 = composeChildPrompt("solo task");
    assert.ok(!p2.includes("CONTEXT FROM PARENT"));
  });

  test("extractAnswer prefers the ANSWER: line", () => {
    assert.equal(extractAnswer("noise\nANSWER: the result\nmore noise"), "the result");
    assert.equal(extractAnswer("just text"), "just text");
    assert.equal(extractAnswer("a\nANSWER: first\nb\nANSWER: second"), "second");
  });

  test("runSubagent with SEA_AGENT_BIN override returns child answer", async () => {
    const prev = process.env.SEA_AGENT_BIN;
    process.env.SEA_AGENT_BIN = fakeCli;
    try {
      const r = await runSubagent({
        task: "summarize",
        context: "parent brief",
        timeoutMs: 15000,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(!r.timedOut);
      assert.match(r.answer, /child-final-answer/);
      const passed = JSON.parse(await import("node:fs").then((f) => f.readFileSync(received, "utf8")));
      assert.ok(passed.prompt.includes("TASK: summarize"));
      assert.ok(passed.prompt.includes("parent brief"));
    } finally {
      if (prev === undefined) delete process.env.SEA_AGENT_BIN;
      else process.env.SEA_AGENT_BIN = prev;
    }
  });

  test("childMemoryEnv canonicalises journal+sidecar, legacy names included", () => {
    const saved = {
      journal: process.env.MNEMO_MEMORY_JOURNAL,
      bin: process.env.MNEMO_MEMSRV_BIN,
      legacy: process.env.SEA_MEMORY_JOURNAL,
      legacyBin: process.env.SEA_MEMSRV_BIN,
    };
    try {
      delete process.env.MNEMO_MEMORY_JOURNAL;
      delete process.env.MNEMO_MEMSRV_BIN;
      // nothing configured -> nothing to carry (both sides resolve defaults)
      assert.deepEqual(childMemoryEnv(), {});
      // modern names pass through as-is
      process.env.MNEMO_MEMORY_JOURNAL = "/tmp/graph.jsonl";
      process.env.MNEMO_MEMSRV_BIN = "/tmp/memsrv";
      assert.deepEqual(childMemoryEnv(), {
        MNEMO_MEMORY_JOURNAL: "/tmp/graph.jsonl",
        MNEMO_MEMSRV_BIN: "/tmp/memsrv",
      });
      // legacy-only config is canonicalised to the modern name, so the child's
      // MemClient (which prefers MNEMO_*) resolves the SAME graph as the parent
      delete process.env.MNEMO_MEMORY_JOURNAL;
      delete process.env.MNEMO_MEMSRV_BIN;
      process.env.SEA_MEMORY_JOURNAL = "/legacy/graph.jsonl";
      process.env.SEA_MEMSRV_BIN = "/legacy/memsrv";
      assert.deepEqual(childMemoryEnv(), {
        MNEMO_MEMORY_JOURNAL: "/legacy/graph.jsonl",
        MNEMO_MEMSRV_BIN: "/legacy/memsrv",
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("runSubagent hands MNEMO_MEMORY_JOURNAL + MNEMO_MEMSRV_BIN to the child", async () => {
    const prev = {
      MNEMO_AGENT_BIN: process.env.MNEMO_AGENT_BIN,
      MNEMO_MEMORY_JOURNAL: process.env.MNEMO_MEMORY_JOURNAL,
      MNEMO_MEMSRV_BIN: process.env.MNEMO_MEMSRV_BIN,
    };
    const childSeen = path.join(tmp, "child-seen.json");
    const envCli = path.join(tmp, "env-agent.mjs");
    writeFileSync(envCli, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(childSeen)}, JSON.stringify({
        journal: process.env.MNEMO_MEMORY_JOURNAL ?? null,
        sidecar: process.env.MNEMO_MEMSRV_BIN ?? null,
      }));
      console.log("ANSWER: env-checked");
    `);
    process.env.MNEMO_AGENT_BIN = envCli;
    process.env.MNEMO_MEMORY_JOURNAL = "/shared/graph.jsonl";
    process.env.MNEMO_MEMSRV_BIN = "/shared/memsrv";
    try {
      const r = await runSubagent({ task: "check env", timeoutMs: 15000 });
      assert.equal(r.exitCode, 0);
      const seen = JSON.parse(await import("node:fs").then((f) => f.readFileSync(childSeen, "utf8")));
      assert.equal(seen.journal, "/shared/graph.jsonl", "child must share the parent's journal");
      assert.equal(seen.sidecar, "/shared/memsrv", "child must share the parent's sidecar");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("timeout kills hung child and reports timedOut", async () => {
    const hangCli = path.join(tmp, "hang-agent.mjs");
    writeFileSync(hangCli, `setTimeout(() => {}, 60000);`);
    const prev = process.env.SEA_AGENT_BIN;
    process.env.SEA_AGENT_BIN = hangCli;
    try {
      const r = await runSubagent({ task: "x", timeoutMs: 800 });
      assert.ok(r.timedOut);
      assert.equal(r.answer, "");
    } finally {
      if (prev === undefined) delete process.env.SEA_AGENT_BIN;
      else process.env.SEA_AGENT_BIN = prev;
    }
  });

  test("runSubagent marks the child so the approval gate fails closed there", async () => {
    const childSeen = path.join(tmp, "child-flag.json");
    const flagCli = path.join(tmp, "flag-agent.mjs");
    writeFileSync(flagCli, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(childSeen)}, JSON.stringify({
        child: process.env.MNEMO_SUBAGENT_CHILD ?? null,
      }));
      console.log("ANSWER: flag-checked");
    `);
    const prev = process.env.MNEMO_AGENT_BIN;
    process.env.MNEMO_AGENT_BIN = flagCli;
    try {
      const r = await runSubagent({ task: "check flag", timeoutMs: 15000 });
      assert.equal(r.exitCode, 0);
      const seen = JSON.parse(await import("node:fs").then((f) => f.readFileSync(childSeen, "utf8")));
      assert.equal(seen.child, "1", "child must carry MNEMO_SUBAGENT_CHILD=1 (12.1)");
    } finally {
      if (prev === undefined) delete process.env.MNEMO_AGENT_BIN;
      else process.env.MNEMO_AGENT_BIN = prev;
    }
  });

  test("runSubagent hands the child the session's PI_* env, replacing stale values (D6)", async () => {
    const childSeen = path.join(tmp, "child-pi-env.json");
    const envCli = path.join(tmp, "pi-env-agent.mjs");
    writeFileSync(envCli, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(childSeen)}, JSON.stringify({
        session: process.env.PI_SESSION_ID ?? null,
        file: process.env.PI_SESSION_FILE ?? null,
        provider: process.env.PI_PROVIDER ?? null,
        model: process.env.PI_MODEL ?? null,
        level: process.env.PI_REASONING_LEVEL ?? null,
        cred: process.env.SEA_TEST_FAKE_API_KEY ?? null,
      }));
      console.log("ANSWER: pi-env-checked");
    `);
    const prev = {
      bin: process.env.MNEMO_AGENT_BIN,
      id: process.env.PI_SESSION_ID,
      cred: process.env.SEA_TEST_FAKE_API_KEY,
    };
    process.env.MNEMO_AGENT_BIN = envCli;
    process.env.PI_SESSION_ID = "stale-parent-session";
    process.env.SEA_TEST_FAKE_API_KEY = "«redacted:sk-…»";
    try {
      const r = await runSubagent({
        task: "check pi env",
        timeoutMs: 15000,
        session: {
          sessionId: "child-sess",
          sessionFile: "/tmp/sessions/child-sess.jsonl",
          provider: "acme",
          model: "m1",
          reasoningLevel: "low",
        },
      });
      assert.equal(r.exitCode, 0);
      const seen = JSON.parse(await import("node:fs").then((f) => f.readFileSync(childSeen, "utf8")));
      assert.equal(seen.session, "child-sess", "the live session id, not the stale one");
      assert.equal(seen.file, "/tmp/sessions/child-sess.jsonl");
      assert.equal(seen.provider, "acme");
      assert.equal(seen.model, "m1");
      assert.equal(seen.level, "low");
      assert.equal(seen.cred, null, "12.7 still holds: credentials never reach the child");
    } finally {
      for (const [k, v] of Object.entries({ MNEMO_AGENT_BIN: prev.bin, PI_SESSION_ID: prev.id, SEA_TEST_FAKE_API_KEY: prev.cred })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("spawn_subagent resolves the session from pi's call context (D6)", async () => {
    const childSeen = path.join(tmp, "child-ctx-env.json");
    const envCli = path.join(tmp, "ctx-env-agent.mjs");
    writeFileSync(envCli, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(childSeen)}, JSON.stringify({
        session: process.env.PI_SESSION_ID ?? null,
        provider: process.env.PI_PROVIDER ?? null,
        model: process.env.PI_MODEL ?? null,
        level: process.env.PI_REASONING_LEVEL ?? null,
      }));
      console.log("ANSWER: ctx-env-checked");
    `);
    const prevBin = process.env.MNEMO_AGENT_BIN;
    process.env.MNEMO_AGENT_BIN = envCli;
    try {
      const ctx = {
        sessionManager: { getSessionId: () => "tool-sess", getSessionFile: () => undefined },
        model: { provider: "acme", id: "m2" },
        thinkingLevel: "high",
      };
      const res = await subagentSpawnTool.execute("s1", { task: "check ctx env" }, undefined, undefined, ctx as any);
      assert.match(textOf(res), /ctx-env-checked/);
      const seen = JSON.parse(await import("node:fs").then((f) => f.readFileSync(childSeen, "utf8")));
      assert.equal(seen.session, "tool-sess");
      assert.equal(seen.provider, "acme");
      assert.equal(seen.model, "m2");
      assert.equal(seen.level, "high");
    } finally {
      if (prevBin === undefined) delete process.env.MNEMO_AGENT_BIN;
      else process.env.MNEMO_AGENT_BIN = prevBin;
    }
  });

  // --- 6(b): the delegation depth budget ------------------------------------

  test("the depth budget is read from the env with a documented default", () => {
    assert.equal(DEFAULT_SUBAGENT_MAX_DEPTH, 3, "the documented default");
    assert.equal(subagentDepth({}), 0, "the agent the user started is depth 0");
    assert.equal(subagentDepth({ [SUBAGENT_DEPTH_ENV]: "2" }), 2);
    assert.equal(subagentDepth({ [SUBAGENT_DEPTH_ENV]: " 4 " }), 4);
    for (const bad of ["", "  ", "two", "-1", "1.5", "many"]) {
      assert.equal(subagentDepth({ [SUBAGENT_DEPTH_ENV]: bad }), 0, `"${bad}" is not a depth`);
    }
    assert.equal(subagentMaxDepth({}), DEFAULT_SUBAGENT_MAX_DEPTH);
    assert.equal(subagentMaxDepth({ [SUBAGENT_MAX_DEPTH_ENV]: "1" }), 1);
    assert.equal(subagentMaxDepth({ [SUBAGENT_MAX_DEPTH_ENV]: "0" }), 0, "0 is a real budget: no delegation");
    for (const bad of ["", "lots", "-3", "2.5"]) {
      assert.equal(subagentMaxDepth({ [SUBAGENT_MAX_DEPTH_ENV]: bad }), DEFAULT_SUBAGENT_MAX_DEPTH,
        `"${bad}" falls back to the documented default, never to unlimited`);
    }
  });

  test("the refusal names the limit and how to raise it", () => {
    assert.equal(subagentDepthRefusal(0, 3), null);
    assert.equal(subagentDepthRefusal(2, 3), null);
    const msg = subagentDepthRefusal(3, 3)!;
    assert.match(msg, /^spawn_subagent refused/);
    assert.match(msg, /depth limit reached/);
    assert.match(msg, /at depth 3/);
    assert.match(msg, /MNEMO_SUBAGENT_DEPTH=3/);
    assert.match(msg, /of a maximum 3/);
    assert.match(msg, /MNEMO_SUBAGENT_MAX_DEPTH=4/, "the way to raise it is spelled out");
    // 0 forbids delegation outright: even the top-level agent is refused
    assert.match(subagentDepthRefusal(0, 0)!, /of a maximum 0/);
  });

  test("spawn_subagent refuses past the cap with a normal tool result, and never spawns", async () => {
    const prev = {
      depth: process.env[SUBAGENT_DEPTH_ENV],
      max: process.env[SUBAGENT_MAX_DEPTH_ENV],
      bin: process.env.MNEMO_AGENT_BIN,
    };
    // A binary that would fail loudly if it were ever run.
    process.env.MNEMO_AGENT_BIN = path.join(tmp, "must-not-run.mjs");
    try {
      process.env[SUBAGENT_DEPTH_ENV] = "3"; // the default cap
      delete process.env[SUBAGENT_MAX_DEPTH_ENV];
      const res = await subagentSpawnTool.execute("s-cap", { task: "delegate anyway" });
      const text = textOf(res);
      assert.match(text, /depth limit reached/);
      assert.match(text, /of a maximum 3/);
      assert.match(text, /MNEMO_SUBAGENT_MAX_DEPTH=4/);
      assert.ok(!/failed to start/.test(text), "the guard fires before anything is spawned");
      assert.equal(textOf(res, 1), "", "one text block: an ordinary tool result, not a crash");

      // A deeper budget on the same process lets it through again.
      process.env[SUBAGENT_MAX_DEPTH_ENV] = "4";
      const deeper = textOf(await subagentSpawnTool.execute("s-cap2", { task: "delegate anyway" }));
      assert.ok(!/depth limit reached/.test(deeper),
        "MNEMO_SUBAGENT_MAX_DEPTH is the override");
      assert.match(deeper, /sub-agent finished in .*exit=1/,
        "it really launched a child once the budget allowed it (the stub CLI is not a file, so node exits 1)");
    } finally {
      for (const [k, v] of Object.entries({
        [SUBAGENT_DEPTH_ENV]: prev.depth,
        [SUBAGENT_MAX_DEPTH_ENV]: prev.max,
        MNEMO_AGENT_BIN: prev.bin,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("the child is stamped one level deeper, and a caller cannot fake it", async () => {
    const childSeen = path.join(tmp, "depth-child.json");
    const depthCli = path.join(tmp, "depth-agent.mjs");
    writeFileSync(depthCli, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(childSeen)}, JSON.stringify({
        depth: process.env.MNEMO_SUBAGENT_DEPTH ?? null,
        max: process.env.MNEMO_SUBAGENT_MAX_DEPTH ?? null,
      }));
      console.log("ANSWER: depth-checked");
    `);
    const prev = {
      bin: process.env.MNEMO_AGENT_BIN,
      depth: process.env[SUBAGENT_DEPTH_ENV],
      max: process.env[SUBAGENT_MAX_DEPTH_ENV],
    };
    const readSeen = async () =>
      JSON.parse(await import("node:fs").then((f) => f.readFileSync(childSeen, "utf8")));
    process.env.MNEMO_AGENT_BIN = depthCli;
    process.env[SUBAGENT_MAX_DEPTH_ENV] = "5";
    try {
      // the top-level agent (no depth of its own) spawns depth 1
      delete process.env[SUBAGENT_DEPTH_ENV];
      await runSubagent({ task: "depth 1", timeoutMs: 15000 });
      assert.equal((await readSeen()).depth, "1");
      assert.equal((await readSeen()).max, "5", "the budget is inherited by children");

      // a child at depth 2 spawns depth 3 -- even when the caller passes an env
      // that claims to be shallower
      process.env[SUBAGENT_DEPTH_ENV] = "2";
      await runSubagent({ task: "depth 3", timeoutMs: 15000, env: { [SUBAGENT_DEPTH_ENV]: "0" } });
      assert.equal((await readSeen()).depth, "3", "the parent stamps the depth, last");
    } finally {
      for (const [k, v] of Object.entries({
        MNEMO_AGENT_BIN: prev.bin,
        [SUBAGENT_DEPTH_ENV]: prev.depth,
        [SUBAGENT_MAX_DEPTH_ENV]: prev.max,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("cleanup", () => { rmSync(tmp, { recursive: true, force: true }); });
});
