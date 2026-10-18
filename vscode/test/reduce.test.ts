import { describe, expect, test } from "bun:test";
import { initial, matchCommands, reduce, tree } from "../src/webview/reduce.ts";
import type { Block, CommandInfo, RosterNode, RpcEvent } from "../src/protocol.ts";

const user = (id: string): Block => ({ kind: "user", id, text: id });
const t = (o: Partial<Extract<RpcEvent, { type: "transcript" }>>): RpcEvent => ({ type: "transcript", reset: false, epoch: 0, from: 0, committed: [], live: [], working: null, queue: [], ...o });

describe("reduce", () => {
  test("committed blocks append at `from`, a reset replaces", () => {
    let s = reduce(initial(), t({ reset: true, committed: [user("a")] }));
    s = reduce(s, t({ from: 1, committed: [user("b")] }));
    expect(s.committed.map((b) => b.id)).toEqual(["a", "b"]);
    s = reduce(s, t({ reset: true, committed: [user("c")] }));
    expect(s.committed.map((b) => b.id)).toEqual(["c"]);
    expect(s.resetSeq).toBe(2);
  });

  test("a repeated `from` does not duplicate", () => {
    let s = reduce(initial(), t({ reset: true, committed: [user("a")] }));
    s = reduce(s, t({ from: 0, committed: [user("a")] }));
    expect(s.committed).toHaveLength(1);
  });

  test("a dialog opens, closes by its id only", () => {
    let s = reduce(initial(), { type: "dialog", dialog: { id: 3, kind: "confirm", title: "t", message: "m" } });
    s = reduce(s, { type: "dialogClosed", id: 9 });
    expect(s.dialog?.id).toBe(3);
    s = reduce(s, { type: "dialogClosed", id: 3 });
    expect(s.dialog).toBeUndefined();
  });

  test("a failed request becomes a problem, a good one changes nothing", () => {
    const s = reduce(initial(), { type: "result", id: 1, ok: false, error: "toastMax is between 1 and 6" });
    expect(s.problem).toBe("toastMax is between 1 and 6");
    expect(reduce(s, { type: "result", id: 2, ok: true })).toBe(s);
  });

  test("settings keep the definitions sent once", () => {
    let s = reduce(initial(), { type: "settings", values: { a: 1 }, defs: { groups: ["Look"], items: [] } });
    s = reduce(s, { type: "settings", values: { a: 2 } });
    expect(s.settings).toEqual({ a: 2 });
    expect(s.defs?.groups).toEqual(["Look"]);
  });
});

describe("matchCommands", () => {
  const cmds: CommandInfo[] = ["memory", "model", "remember", "mode"].map((name) => ({ name, description: "", source: "builtin" as const }));
  test("prefix first, then contains; nothing once an argument starts", () => {
    expect(matchCommands(cmds, "/mo").map((c) => c.name)).toEqual(["model", "mode", "memory"]);
    expect(matchCommands(cmds, "/mem").map((c) => c.name)).toEqual(["memory", "remember"]);
    expect(matchCommands(cmds, "/memory words")).toEqual([]);
    expect(matchCommands(cmds, "hello")).toEqual([]);
  });
});

describe("tree", () => {
  const n = (id: number, parent?: number): RosterNode => ({ id, parent, kind: parent ? "sub" : "root", label: `n${id}`, task: "", access: "full", status: "idle", steps: [], stepCount: 0, startedAt: 0, woken: false, wakeSpend: 0 });
  test("children follow their parent; one whose parent is gone is a root", () => {
    expect(tree([n(1), n(3, 2), n(2, 1), n(5, 9)]).map((x) => [x.node.id, x.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [5, 0],
    ]);
  });
});
