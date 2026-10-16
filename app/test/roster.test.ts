/** The roster decides who may talk to whom; these are its rules, one by one. */
import { test, expect } from "bun:test";
import { LIMITS, Roster, RosterError, clean, forest, type PeerMessage } from "../src/runtime/roster.ts";

/** A roster whose nodes record what they were sent. */
function world() {
  const r = new Roster(() => clock.t);
  const clock = { t: 1_000_000 };
  const inbox = new Map<number, PeerMessage[]>();
  const handle = (id: () => number) => ({
    deliver: (m: PeerMessage) => void (inbox.get(id()) ?? inbox.set(id(), []).get(id())!).push(m),
    stop: () => {},
  });
  const root = (name: string) => {
    let id = 0;
    const n = r.addRoot(name, handle(() => id));
    id = n.id;
    return n.id;
  };
  const sub = (parent: number, name: string, access: "read-only" | "full" = "read-only") => {
    const n = r.addSub(parent, { label: name, task: `do ${name}`, access });
    r.attach(n.id, handle(() => n.id));
    return n.id;
  };
  return { r, clock, inbox, root, sub };
}

test("a node reaches its parent, children, siblings and its ancestors' siblings, and nobody else", () => {
  const { r, root, sub } = world();
  const a = root("A");
  const b = root("B");
  const c = root("C"); // never linked
  r.link(a, b);
  const a1 = sub(a, "a1", "full");
  const a2 = sub(a, "a2", "full");
  const a11 = sub(a1, "a11", "full");
  const b1 = sub(b, "b1");

  const reach = (x: number) => r.family(x).map((n) => n.id).sort((p, q) => p - q);
  expect(reach(a)).toEqual([b, a1, a2].sort((p, q) => p - q)); // linked root and its children
  expect(reach(a1)).toEqual([a, a2, a11, b].sort((p, q) => p - q)); // parent, sibling, child, parent's sibling
  expect(reach(a11)).toEqual([a1, a2, b].sort((p, q) => p - q)); // its parent, its parent's sibling, its grandparent's sibling (not the grandparent)
  // Not reachable: another tree's descendants, an unlinked root, cousins' children.
  expect(r.canReach(a11, b1)).toBe(false);
  expect(r.canReach(a1, b1)).toBe(false);
  expect(r.canReach(a, b1)).toBe(false);
  for (const x of [a, b, a1, a2, a11, b1]) expect(r.canReach(x, c)).toBe(false);
  expect(r.canReach(c, a)).toBe(false);
  expect(r.canReach(a, a)).toBe(false);
});

test("a send is refused outside the family, to the ended, and from the ended; inside it arrives framed with who sent it", () => {
  const { r, root, sub, inbox } = world();
  const a = root("A");
  const b = root("B");
  const c = root("C");
  r.link(a, b);
  const a1 = sub(a, "researcher");
  expect(r.send(a1, b, "found it")).toEqual({ ok: true }); // a sub-agent reaches its parent's sibling
  expect(inbox.get(b)![0]).toMatchObject({ from: a1, fromLabel: "researcher", fromRole: "sub-agent (depth 1)", text: "found it" });
  expect(r.send(a1, c, "hi")).toMatchObject({ ok: false });
  expect(r.send(a, 9999, "hi")).toMatchObject({ ok: false });
  expect(r.send(a1, a1, "hi")).toMatchObject({ ok: false });
  r.finish(a1, "done", "ok");
  expect(r.send(a1, a, "late")).toMatchObject({ ok: false, reason: "you are no longer running" });
  expect(r.send(a, a1, "late")).toMatchObject({ ok: false });
  expect(inbox.get(c)).toBeUndefined();
});

test("unlinking, or closing a root, takes its reach away and stops its tree", () => {
  const { r, root, sub } = world();
  const a = root("A");
  const b = root("B");
  r.link(a, b);
  const a1 = sub(a, "a1");
  expect(r.canReach(a1, b)).toBe(true);
  r.unlink(b);
  expect(r.canReach(a1, b)).toBe(false);
  expect(r.canReach(a, b)).toBe(false);
  expect(r.groupOf(a)).toBeUndefined(); // a group of one dissolves
  r.link(a, b);
  r.removeRoot(a);
  expect(r.get(a)).toBeUndefined();
  expect(r.get(a1)).toMatchObject({ status: "stopped" });
  expect(r.canReach(b, a)).toBe(false);
  expect(r.groupOf(b)).toBeUndefined();
});

test("linking is for roots only, merges groups, and a sub-agent cannot be linked", () => {
  const { r, root, sub } = world();
  const [a, b, c, d] = [root("A"), root("B"), root("C"), root("D")] as [number, number, number, number];
  const a1 = sub(a, "a1");
  expect(r.link(a, a1)).toBe(false);
  expect(r.link(a, a)).toBe(false);
  expect(r.link(a, b)).toBe(true);
  expect(r.link(a, b)).toBe(false);
  r.link(c, d);
  r.link(b, c); // two groups become one
  expect(r.linked(a).map((n) => n.id).sort()).toEqual([b, c, d].sort());
});

test("depth, fan-out and total limits are enforced with a message the model can read", () => {
  const { r, root, sub } = world();
  const a = root("A");
  let at = a;
  for (let d = 1; d <= LIMITS.maxDepth; d++) at = sub(at, `d${d}`, "full");
  expect(() => r.addSub(at, { label: "too deep", task: "x", access: "read-only" })).toThrow(/nest at most/);

  const b = root("B");
  for (let i = 0; i < LIMITS.maxChildren; i++) sub(b, `k${i}`);
  expect(() => r.addSub(b, { label: "one more", task: "x", access: "read-only" })).toThrow(RosterError);
  expect(() => r.addSub(b, { label: "one more", task: "x", access: "read-only" })).toThrow(/limit 4/);
  // A finished child frees its place.
  r.finish(r.children(b)[0]!.id, "done");
  expect(() => sub(b, "again")).not.toThrow();

  // The conversation-wide cap counts every depth.
  const c = root("C");
  const kids = Array.from({ length: LIMITS.maxChildren }, (_, i) => sub(c, `c${i}`));
  let made = kids.length;
  for (const k of kids) for (let i = 0; i < LIMITS.maxChildren && made < LIMITS.maxLive; i++, made++) r.addSub(k, { label: `g${made}`, task: "x", access: "read-only" });
  expect(made).toBe(LIMITS.maxLive);
  const last = r.children(kids[0]!).find((n) => n.status === "running")!;
  expect(() => r.addSub(last.id, { label: "over", task: "x", access: "read-only" })).toThrow(/limit 16/);
});

test("a read-only agent cannot start a full-access one", () => {
  const { r, root, sub } = world();
  const a = root("A");
  const ro = sub(a, "reader", "read-only");
  expect(() => r.addSub(ro, { label: "writer", task: "x", access: "full" })).toThrow(/read-only/);
  expect(() => r.addSub(ro, { label: "reader2", task: "x", access: "read-only" })).not.toThrow();
});

test("messages are bounded: size, rate, and what an idle node will hold", () => {
  const { r, root, clock } = world();
  const a = root("A");
  const b = root("B");
  r.link(a, b);
  expect(r.send(a, b, "x".repeat(LIMITS.messageChars + 1))).toMatchObject({ ok: false });
  expect(r.send(a, b, "   ")).toMatchObject({ ok: false });
  for (let i = 0; i < LIMITS.inbox; i++) expect(r.send(a, b, `m${i}`)).toEqual({ ok: true });
  // B is idle and holds LIMITS.inbox unread messages: the next is refused.
  expect(r.send(a, b, "one more")).toMatchObject({ ok: false, reason: expect.stringContaining("unread") });
  // Running agents read as they go, so they hold nothing; the rate limit is what bounds them.
  r.setStatus(b, "running");
  let sent = LIMITS.inbox;
  while (sent < LIMITS.sendsPerWindow) {
    expect(r.send(a, b, "go")).toEqual({ ok: true });
    sent++;
  }
  expect(r.send(a, b, "too fast")).toMatchObject({ ok: false, reason: expect.stringContaining("too fast") });
  clock.t += LIMITS.rateWindowMs + 1;
  expect(r.send(a, b, "again")).toEqual({ ok: true });
});

test("everything an agent writes is cleaned of terminal control codes and secrets before anyone sees it", () => {
  const { r, root, sub } = world();
  const a = root("A");
  const evil = "\x1b]52;c;ZXZpbA==\x07\x1b[2J ok ‮ reversed \u0085 key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const n = r.addSub(a, { label: evil, task: evil, access: "read-only" });
  r.step(n.id, evil);
  r.finish(n.id, "done", evil);
  const got = r.get(n.id)!;
  for (const text of [got.label, got.task, got.steps[0]!, got.answer!]) {
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/);
    expect(text).not.toContain("sk-ant-api03-AAAA");
  }
  expect(clean("a\nb\tc", 20)).toBe("a\nb\tc");
  expect(clean("x".repeat(50), 10)).toHaveLength(10);
  void sub;
});

test("a message is stored for the feed redacted and clipped, and is cleaned on the way in", () => {
  const { r, root, inbox } = world();
  const a = root("A");
  const b = root("B");
  r.link(a, b);
  r.send(a, b, "token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\x1b[31m red");
  const event = r.snapshot().events.findLast((e) => e.kind === "message")!;
  expect(JSON.stringify(event)).not.toContain("sk-ant");
  expect(inbox.get(b)![0]!.text).not.toContain("\x1b");
});

test("the view the interface gets has no way to change anything", () => {
  const { r, root } = world();
  root("A");
  const view: import("../src/runtime/roster.ts").RosterView = r;
  // Structural: a RosterView offers exactly these two members.
  expect(Object.keys({ snapshot: view.snapshot, subscribe: view.subscribe }).sort()).toEqual(["snapshot", "subscribe"]);
  const snap = view.snapshot();
  snap.nodes[0]!.label = "tampered"; // a snapshot is a copy
  expect(r.get(snap.nodes[0]!.id)!.label).toBe("A");
});

test("forest lists each root with its descendants depth-first", () => {
  const { r, root, sub } = world();
  const a = root("A");
  const a1 = sub(a, "a1", "full");
  sub(a1, "a11");
  sub(a, "a2");
  root("B");
  expect(forest(r.snapshot()).map((x) => `${"  ".repeat(x.depth)}${x.node.label}`)).toEqual(["A", "  a1", "    a11", "  a2", "B"]);
});
