/**
 * The pixel language's moving parts: the pulse that replaced the spinner,
 * Mne's poses, the header's reactions, and the activity a real run emits.
 */
import { test, expect, afterEach } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { pulseFrame } from "../src/ui/components/Pulse.tsx";
import { reaction } from "../src/ui/components/MneBadge.tsx";
import { ditherFrame, mneMini, pixelText } from "../src/ui/pixel.ts";
import { engramFrame } from "../src/ui/engram.ts";
import { mnemoEnv } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

test("the scanner sweeps one lit pixel across and back", () => {
  const lit = (f: number) => pulseFrame("tool", 6, f).findIndex((c) => c.ch === "█");
  expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(lit)).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]);
  expect(pulseFrame("think", 8, 3)).toHaveLength(8);
  expect(pulseFrame("think", 8, 3)).not.toEqual(pulseFrame("think", 8, 9));
  expect(pulseFrame("wait", 4, 0)[0]!.ch).toBe("■");
});

test("thinking is an ordered dither that moves; the answer streaming fills in", () => {
  const a = ditherFrame(24, 2, 3);
  expect(a).toHaveLength(2);
  expect(a[0]).toHaveLength(24);
  expect(new Set(a.flat().map((c) => c.ch)).size).toBeGreaterThan(2);
  expect(ditherFrame(24, 2, 3)).toEqual(a);
  expect(ditherFrame(24, 2, 12)).not.toEqual(a);
  const fill = (f: number) => pulseFrame("write", 4, f).map((c) => c.ch).join("");
  expect(fill(0)).toBe("    ");
  expect(fill(8)).toBe("█   ");
  expect(fill(32)).toBe("████");
});

test("Engram settles into Mne in half-block pixels, from a field of glyphs", () => {
  const half = (cells: ReturnType<typeof engramFrame>) => cells.flat().filter((c) => "▀▄█".includes(c.ch)).length;
  const settled = engramFrame({ cols: 40, rows: 15, t: 0, animate: false });
  expect(settled).toHaveLength(15);
  expect(settled[0]).toHaveLength(40);
  expect(half(settled)).toBeGreaterThan(60);
  expect(settled.flat().some((c) => ".:+x*#".includes(c.ch) && c.ch !== " ")).toBe(true);
  const early = engramFrame({ cols: 40, rows: 15, t: 0.2 });
  expect(half(early)).toBeLessThan(half(settled) / 4);
  expect(engramFrame({ cols: 40, rows: 15, t: 1.3, seed: 7 })).toEqual(engramFrame({ cols: 40, rows: 15, t: 1.3, seed: 7 }));
  expect(engramFrame({ cols: 40, rows: 15, t: 1.3, seed: 8 })).not.toEqual(engramFrame({ cols: 40, rows: 15, t: 1.3, seed: 7 }));
});

test("Mne's eyes go where it looks; the font draws every letter", () => {
  const eyeRow = (look: Parameters<typeof mneMini>[1]) => mneMini("#ffffff", look)[1]!.map((p) => (p === "#ffffff" ? "G" : p === null ? "." : "x")).join("");
  expect(eyeRow("ahead")).not.toBe(eyeRow("left"));
  const text = pixelText("AZ09");
  expect(text[0]!.filter(Boolean).length).toBeGreaterThan(8);
});

test("reactions say what happened", () => {
  expect(reaction({ seq: 1, kind: "check", ok: true, text: "bun test", tests: { passed: 12, failed: 0, skipped: 0 }, at: 0 }).label).toBe("✓ 12 passed");
  expect(reaction({ seq: 1, kind: "check", ok: false, text: "npm test", at: 0 }).label).toBe("✗ check failed");
  expect(reaction({ seq: 1, kind: "learned", text: "x", count: 2, at: 0 }).label).toBe("◈ +2 learned");
});

test("a check in a real run becomes an activity with its test counts", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  e.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo running tests && printf ' 4 pass\\n 1 fail\\n'" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("one test fails")),
  ]);
  await e.controller.submit("run the tests");
  await e.idle();
  const a = e.controller.snapshot().activity;
  expect(a).toMatchObject({ kind: "check", ok: false, tests: { passed: 4, failed: 1 } });
});

test("a tool's tile, an edit's diff strip and a test run's heatmap render", async () => {
  const React = (await import("react")).default;
  const { render } = await import("ink-testing-library");
  const { BlockView, toolTile } = await import("../src/ui/components/Blocks.tsx");
  const { MotionContext } = await import("../src/ui/components/motion.ts");
  expect(toolTile("bash").ch).toBe("$");
  expect(toolTile("memory_search").ch).toBe("◈");
  expect(toolTile("something_else").ch).toBe("▪");
  const show = (block: unknown) =>
    render(React.createElement(MotionContext.Provider, { value: false }, React.createElement(BlockView, { block: block as never, cwd: "/p", expanded: false }))).lastFrame()!;
  const edit = show({
    kind: "tool",
    id: "e",
    name: "edit",
    args: { path: "/p/a.ts" },
    status: "done",
    output: "",
    details: { diff: " 1 a\n-2 b\n+2 c\n+3 d" },
  });
  expect(edit).toContain("+2 −1  ▀▀▀");
  const tests = show({ kind: "tool", id: "t", name: "bash", args: { command: "bun test" }, status: "done", output: " 5 pass\n 1 fail\n" });
  expect(tests).toContain("▀▀▀▀▀▀  5 passed · 1 failed");
});
