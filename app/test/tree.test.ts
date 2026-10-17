/** The tree as text, the card's relation line, and which panes a family split picks. */
import { test, expect } from "bun:test";
import { LIMITS, Roster } from "../src/runtime/roster.ts";
import { familyPanes, relation, treeOf, withNewSub } from "../src/ui/tree.ts";
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
  // A message held at the chain bound shows on the card until the user prompts.
  r.get(a)!.hops = LIMITS.hops; // alpha is at the end of a long chain of messages
  r.send(a, b, "one");
  r.send(a, b, "two");
  expect(relation(r.snapshot(), b)).toBe("⇄ alpha · ✉ 2 waiting for you");
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

test("a new sub-agent joins the split when its agent is on screen, taking a free pane or one whose sub-agent ended", () => {
  const { r, a, b, sub } = world();
  const s1 = sub(a, "s1");
  expect(withNewSub(["a1"], r.snapshot(), s1)).toEqual(["a1", `n${s1}`]);
  expect(withNewSub(["a2"], r.snapshot(), s1)).toEqual(["a2"]); // its agent is not shown
  const deep = sub(s1, "deep");
  expect(withNewSub(["a1", `n${s1}`], r.snapshot(), deep)).toEqual(["a1", `n${s1}`, `n${deep}`]); // any depth
  const s2 = sub(a, "s2");
  const full = ["a1", "a2", `n${s1}`, `n${deep}`];
  expect(withNewSub(full, r.snapshot(), s2)).toEqual(full); // no room, nothing ended: the split stays
  r.finish(deep, "done");
  expect(withNewSub(full, r.snapshot(), s2)).toEqual(["a1", "a2", `n${s1}`, `n${s2}`]);
  expect(withNewSub(["a1", `n${s2}`], r.snapshot(), s2)).toEqual(["a1", `n${s2}`]); // already there
  void b;
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
  expect(feed).toContain("✉ scout → beta (woke it): found the bug");
  expect(feed).toContain("◇ beta closed");
  expect(feed).toContain("⇄ alpha linked with beta");
});
