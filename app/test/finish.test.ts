/**
 * The last pieces of the pixel language: best-of as a race from the
 * interface, toasts from agents off screen, themes, the context gauge and
 * the exit card.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { mnemoEnv } from "./helpers.ts";
import { laneTrack } from "../src/ui/components/Race.tsx";
import { toastFrame } from "../src/ui/Toasts.tsx";
import { contextGauge } from "../src/ui/components/Footer.tsx";
import { applyTheme, palette, themed, themeName, THEMES } from "../src/ui/theme.ts";
import { exitLine, summaryParts } from "../src/ui/ExitCard.tsx";
import { Fleet } from "../src/runtime/fleet.ts";
import { workspaceSource } from "../src/runtime/workspace-source.ts";
import { Shell } from "../src/ui/Shell.tsx";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  applyTheme("night");
  for (const e of envs.splice(0)) await e.close().catch(() => {});
});
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test("/bestof races candidates, applies the smallest that passes, and draws the lanes", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  // Windows git defaults to autocrlf=true: a patch applied to the project would get CRLF line endings.
  Bun.spawnSync(["git", "config", "core.autocrlf", "false"], { cwd: e.cwd });
  // Stand-in candidates: the second writes the right value, the third the right value and more.
  (e.controller as unknown as { options: Record<string, unknown> }).options.bestOfRunner = async (i: number, cwd: string) => {
    if (i === 1) fs.writeFileSync(path.join(cwd, "answer.txt"), "42\n");
    if (i === 2) {
      fs.writeFileSync(path.join(cwd, "answer.txt"), "42\n");
      fs.writeFileSync(path.join(cwd, "extra.txt"), "a\nb\n");
    }
    return `candidate ${i + 1}`;
  };
  await e.controller.submit('/bestof 3 "grep -qx 42 answer.txt" write the answer');
  for (let t = 0; t < 100 && !e.controller.snapshot().race?.done; t++) await wait(50);
  const race = e.controller.snapshot().race!;
  expect(race.winner).toBe(2);
  expect(race.lanes.map((l) => l.state)).toEqual(["failed", "passed", "passed"]);
  expect(fs.readFileSync(path.join(e.cwd, "answer.txt"), "utf8")).toBe("42\n");
  expect(fs.existsSync(path.join(e.cwd, "extra.txt"))).toBe(false);
  const titles = e.controller.transcript.snapshot().committed.flatMap((b) => (b.kind === "memory" ? [b.title] : []));
  expect(titles).toContain("Best of 3: candidate 2 applied");

  expect(laneTrack("passed", 0, 10, 0, true)).toBe("██████████");
  expect(laneTrack("failed", 0, 10, 0, false)).toBe("▓▓▒▒░░░░░░");
  expect(laneTrack("running", 30_000, 10, 0, false).trimEnd()).toMatch(/^▸+▶$/);
});

test("/bestof without a check explains itself", async () => {
  const e = await mnemoEnv();
  envs.push(e);
  await e.controller.submit("/bestof 3 do it");
  const last = e.controller.transcript.snapshot().committed.at(-1);
  expect(last && last.kind === "notice" ? last.text : "").toContain("Usage: /bestof");
});

test("an agent off screen that learns something shows up as a toast", async () => {
  const a = await mnemoEnv();
  const b = await mnemoEnv();
  envs.push(a, b);
  const fleet = new Fleet(async () => {
    throw new Error("no");
  }, { onEmpty: () => {} });
  fleet.adopt(a.cwd, { controller: a.controller, host: a.host, source: workspaceSource(a.controller, a.host, a.home) });
  const second = fleet.adopt(b.cwd, { controller: b.controller, host: b.host, source: workspaceSource(b.controller, b.host, b.home) });
  const r = render(React.createElement(Shell, { fleet, motion: false }));
  await wait();
  // The second agent is not on screen; it learns two facts.
  (b.controller as unknown as { note: (n: unknown) => void }).note({ kind: "learned", items: ["x: 1", "y: 2"] });
  // Poll rather than guess: how long a frame takes depends on the machine.
  for (let t = 0; t < 60 && !r.lastFrame()?.includes(`${second.name}  ◈ +2 learned`); t++) await wait(50);
  expect(r.lastFrame()).toContain(`${second.name}  ◈ +2 learned`);
  r.unmount();
});

test("themes recolour in place, and pixel art follows", () => {
  const night = palette.magenta;
  applyTheme("paper");
  expect(themeName()).toBe("paper");
  expect(palette.magenta).toBe(THEMES.paper.colors.magenta);
  expect(themed(night)).toBe(THEMES.paper.colors.magenta);
  applyTheme("night");
  expect(palette.magenta).toBe(night);
});

test("/theme switches and remembers", async () => {
  const e = await mnemoEnv();
  envs.push(e);
  let saved = "";
  (e.controller as unknown as { options: Record<string, unknown> }).options.onTheme = (n: string) => (saved = n);
  await e.controller.submit("/theme gameboy");
  expect(themeName()).toBe("gameboy");
  expect(saved).toBe("gameboy");
});

test("the context gauge, toasts sliding and dissolving, the exit card", () => {
  expect(contextGauge(0).bar).toBe("░░░░░░░░");
  expect(contextGauge(50).bar).toBe("████░░░░");
  expect(contextGauge(90).tone).toBe(palette.magenta);
  expect(toastFrame("hello", 0).shift).toBeGreaterThan(0);
  expect(toastFrame("hello", 2000)).toEqual({ text: "hello", shift: 0 });
  expect(toastFrame("hello", 4400).text).toMatch(/[▓▒░ ]/);
  const s = { agents: 2, turns: 7, files: 3, learned: 4, cost: 0.031, startedAt: 0 };
  expect(summaryParts(s, 12 * 60_000)).toEqual(["2 agents", "7 turns", "3 files changed", "+4 learned", "$0.031", "12m 0s"]);
  expect(exitLine(s, 0).replace(/\x1b\[[0-9;]*m/g, "")).toBe("▞▚ mnemo · 2 agents · 7 turns · 3 files changed · +4 learned · $0.031 · 0s");
});
