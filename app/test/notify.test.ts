/**
 * A long turn that ends, or an approval that opens, while the terminal is in
 * the background sends one notification; in front, or quick, nothing.
 */
import { test, expect } from "bun:test";
import { Notifier, notification, parseFocus, NOTIFY_AFTER_MS } from "../src/ui/notify.ts";

function fakeAgent() {
  const ls = new Set<() => void>();
  const ds = new Set<() => void>();
  let working: { since: number } | null = null;
  let dialog: unknown = null;
  return {
    transcript: { subscribe: (l: () => void) => (ls.add(l), () => ls.delete(l)), snapshot: () => ({ working }) },
    dialogs: { subscribe: (l: () => void) => (ds.add(l), () => ds.delete(l)), current: () => dialog },
    work: (since: number | null) => {
      working = since === null ? null : { since };
      for (const l of ls) l();
    },
    ask: (d: unknown) => {
      dialog = d;
      for (const l of ds) l();
    },
  };
}

test("focus reports: the last one in a chunk wins", () => {
  expect(parseFocus("abc")).toBeUndefined();
  expect(parseFocus("\x1b[O")).toBe(false);
  expect(parseFocus("\x1b[O\x1b[I")).toBe(true);
});

test("a notification is one clean line", () => {
  expect(notification("a\x07b\x1b]c\nd")).toBe("\x1b]9;a b ]c d\x07\x07");
});

test("only a long turn that ends in the background notifies", () => {
  const out: string[] = [];
  let now = 0;
  const n = new Notifier((s) => out.push(s), () => now);
  const a = fakeAgent();
  n.watch("shop", a);

  a.work(0);
  now = NOTIFY_AFTER_MS + 5_000;
  a.work(null);
  expect(out).toEqual([]); // in front

  n.input("\x1b[O");
  a.work(now);
  now += 1_000;
  a.work(null);
  expect(out).toEqual([]); // quick

  a.work(now);
  now += 75_000;
  a.work(null);
  expect(out).toEqual([notification("mnemo · shop: done in 1m 15s")]);

  a.ask({ kind: "confirm" });
  a.ask({ kind: "confirm" });
  expect(out).toHaveLength(2);
  expect(out[1]).toContain("waiting for your answer");
});
