/**
 * What the memory panel says, including when it has nothing to say.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeNode, summarizeMemory } from "../src/index.ts";

const dump = (nodes: unknown[]) => ({ nodes });

test("a memory with nodes says how many and what they are", () => {
  const summary = summarizeMemory(
    dump([
      { label: "the rebuild", kind: "episode", area: "tasks" },
      { label: "spine runs on Bun", kind: "fact", state: "active" },
    ]),
  );
  assert.equal(summary.total, 2);
  assert.equal(summary.failed, false);
  assert.match(summary.lines[0]!, /memory: 2 nodes/);
  assert.match(summary.lines[1]!, /the rebuild \[tasks\] episode/);
  assert.match(summary.lines[2]!, /spine runs on Bun — active/);
});

test("an empty memory is described, not treated as a fault", () => {
  const summary = summarizeMemory(dump([]));
  assert.equal(summary.failed, false, "a young installation is not a broken one");
  assert.match(summary.lines.join("\n"), /memory: empty/);
  assert.match(summary.lines.join("\n"), /records as you work/, "and it says why that is expected");
  assert.doesNotMatch(summary.lines.join("\n"), /error|failed|broken/i);
});

test("no answer at all is a different sentence from an empty answer", () => {
  for (const nothing of [null, undefined, {}, { nodes: "not an array" }, "text"]) {
    const summary = summarizeMemory(nothing);
    assert.equal(summary.failed, true, `${JSON.stringify(nothing)} is not a dump`);
    assert.match(summary.lines.join("\n"), /no answer from the sidecar/);
    assert.match(summary.lines.join("\n"), /mnemo doctor/, "and it names where to look");
  }
});

test("the list is bounded, and says how much it hid", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ label: `node ${i}` }));
  const summary = summarizeMemory(dump(many), { limit: 5 });
  assert.equal(summary.total, 20, "the count is what is there, not what is drawn");
  assert.equal(summary.lines.length, 1 + 5 + 1);
  assert.match(summary.lines.at(-1)!, /…and 15 more/);

  const exact = summarizeMemory(dump(many), { limit: 20 });
  assert.doesNotMatch(exact.lines.at(-1)!, /more/, "nothing hidden means nothing to say about hiding");
});

test("one node is one node", () => {
  assert.match(summarizeMemory(dump([{ label: "only" }])).lines[0]!, /memory: 1 node$/);
});

test("a node is drawn the way a reader would say it", () => {
  assert.equal(describeNode({ label: "spine" }), "spine");
  assert.equal(describeNode({ label: "spine", area: "tasks" }), "spine [tasks]");
  assert.equal(describeNode({ label: "spine", kind: "episode" }), "spine episode");
  assert.equal(describeNode({ label: "spine", kind: "fact" }), "spine", "a fact is the default, not a label");
  assert.equal(describeNode({}), "(unlabelled)", "a node with no name still gets a line");
  assert.equal(describeNode({ label: "  " }), "(unlabelled)");
});
