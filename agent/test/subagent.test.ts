import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { composeChildPrompt, extractAnswer, runSubagent, childMemoryEnv } from "../src/tools/subagent.ts";

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

  test("cleanup", () => { rmSync(tmp, { recursive: true, force: true }); });
});
