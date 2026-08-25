import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { composeChildPrompt, extractAnswer, runSubagent } from "../src/tools/subagent.ts";

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
