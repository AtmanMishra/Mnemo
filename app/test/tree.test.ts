/** The tree as text, the card's relation line, and which panes a family split picks. */
import { test, expect } from "bun:test";
import { Roster } from "../src/runtime/roster.ts";
import { familyPanes, relation, treeOf } from "../src/ui/tree.ts";
import { feedLine, playgroundRows } from "../src/ui/Playground.tsx";

function world() {
  let t = 1000;
  const r = new Roster(() => t++);
  const deliver = { deliver() {}, stop() {} };
  const a = r.addRoot("alpha", deliver, 1).id;
  const b = r.addRoot("beta", deliver, 2).id;
  const sub = (p: number, n: string) => r.addSub(p, { label: n, task: `task ${n}`, access: "full" }).id;
  return { r, a, b, sub };
}

test("treeOf draws branches, with the vertical rule continuing under a sibling that has more to come", () => {
  const { r, a, sub } = world();
  const m = sub(a, "mapper");
  sub(m, "reader");
  sub(a, "checker");
  const lines = treeOf(r.snapshot().nodes, a).map((l) => `${l.prefix}${l.node.label}`);
  expect(lines).toEqual(["alpha", "├─ mapper", "│  └─ reader", "└─ checker"]);
});

test("the relation line says who is linked and how many sub-agents are running", () => {
  const { r, a, b, sub } = world();
  expect(relation(r.snapshot(), a)).toBe("");
  r.link(a, b);
  sub(a, "x");
  const y = sub(a, "y");
  r.finish(y, "done");
  expect(relation(r.snapshot(), a)).toBe("⇄ beta · ⑂ 2 sub-agents (1 running)");
  expect(relation(r.snapshot(), b)).toBe("⇄ alpha");
});

test("a family split shows at most four: the agent, its linked roots, then running sub-agents first", () => {
  const { r, a, b, sub } = world();
  r.link(a, b);
  const s1 = sub(a, "s1");
  const s2 = sub(a, "s2");
  const s3 = sub(a, "s3");
  const s4 = sub(a, "s4");
  r.finish(s1, "done");
  r.finish(s2, "done");
  const { keys, hidden } = familyPanes(r.snapshot(), a, 4);
  expect(keys).toHaveLength(4);
  expect(keys.slice(0, 2)).toEqual(["a1", "a2"]); // agents are keyed by their fleet id
  expect(keys.slice(2).sort()).toEqual([`n${s3}`, `n${s4}`].sort()); // the running ones beat the finished
  expect(hidden).toBe(2);
});

test("the playground lists every root with its tree, and the feed reads in words, even for nodes that left", () => {
  const { r, a, b, sub } = world();
  r.link(a, b);
  const s = sub(a, "scout");
  r.send(s, b, "found the bug");
  r.removeRoot(b);
  const snap = r.snapshot();
  expect(playgroundRows(snap).map((x) => x.node.label)).toEqual(["alpha", "scout"]);
  const feed = snap.events.map((e) => feedLine(e, snap.labels).text);
  expect(feed).toContain("⑂ alpha started scout");
  expect(feed).toContain("✉ scout → beta: found the bug");
  expect(feed).toContain("◇ beta closed");
  expect(feed).toContain("⇄ alpha linked with beta");
});
