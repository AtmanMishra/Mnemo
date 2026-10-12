import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Boot, bootFrame, BOOT_MS } from "../src/ui/components/Boot.tsx";
import { MotionContext } from "../src/ui/components/motion.ts";

const info = { version: "9.9.9", columns: 100, rows: 28, stats: { memories: 412, skills: 9, sessions: 37 } };
const pixels = (f: ReturnType<typeof bootFrame>) => f.cells.flat().filter((c) => "▀▄█".includes(c.ch)).length;

test("the sequence: the picture settles out of a field of glyphs, the wire and tagline draw, the stats count up, and it ends", () => {
  const start = bootFrame(0, info);
  const end = bootFrame(BOOT_MS, info);
  expect(start.wire).toBe("");
  expect(start.tagline).toBe("");
  expect(start.stats).toBeUndefined();
  expect(end).toMatchObject({ wire: "◆───◆───◆───◆───◆", tagline: "a coding agent that remembers", done: true });
  expect(end.stats).toBe("◈ 412 memories   ◇ 9 skills   ▣ 37 sessions");
  // Mid-count is between zero and the total.
  const mid = bootFrame(BOOT_MS * 0.85, info).stats!;
  const n = Number(/◈ (\d+)/.exec(mid)![1]);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(412);
  // Deterministic: the same moment is the same frame.
  expect(bootFrame(300, info).cells).toEqual(bootFrame(300, info).cells);
  expect(pixels(end)).toBeGreaterThan(100);
  expect(pixels(start)).toBeLessThan(pixels(end) / 4);
  // The field is wider than the picture, full of glyphs while it settles, and quieter once it has.
  const glyphs = (f: ReturnType<typeof bootFrame>) => f.cells.flat().filter((c) => "·░▒".includes(c.ch)).length;
  expect(end.cells[0]!.length).toBeGreaterThan(52);
  expect(glyphs(bootFrame(300, info))).toBeGreaterThan(20);
  expect(glyphs(end)).toBeLessThan(glyphs(bootFrame(300, info)) / 2);
});

test("without memory there are no stats", () => {
  expect(bootFrame(BOOT_MS, { ...info, stats: undefined }).stats).toBeUndefined();
});

test("without motion the last frame shows and the sequence ends at once; a small terminal gets the wordmark in text", async () => {
  let done = 0;
  const big = render(React.createElement(MotionContext.Provider, { value: false }, React.createElement(Boot, { info, onDone: () => done++ })));
  await new Promise((r) => setTimeout(r, 20));
  expect(done).toBe(1);
  expect(big.lastFrame()).toContain("a coding agent that remembers");
  big.unmount();
  const small = render(React.createElement(MotionContext.Provider, { value: false }, React.createElement(Boot, { info: { ...info, columns: 40, rows: 12 }, onDone: () => {} })));
  expect(small.lastFrame()).toContain("▞ MNEMO ▚");
  small.unmount();
});

test("any key skips it", async () => {
  let done = 0;
  const r = render(React.createElement(MotionContext.Provider, { value: true }, React.createElement(Boot, { info, onDone: () => done++ })));
  await new Promise((res) => setTimeout(res, 50));
  r.stdin.write("x");
  await new Promise((res) => setTimeout(res, 20));
  expect(done).toBe(1);
  r.unmount();
});
