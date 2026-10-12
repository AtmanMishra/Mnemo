/**
 * Every screen fits the terminal it is given: no line wider than the window, no
 * frame taller than it, the composer and the header always there. Swept over
 * sizes from a cramped 30×10 to a wide 200×50, with a conversation that has long
 * lines, a tool call, a code block and a table, and with three agents open.
 */
import { test, expect, afterEach } from "bun:test";
import React from "react";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "ink-testing-library";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Workspace } from "../src/ui/workspace/Workspace.tsx";
import { Fleet } from "../src/runtime/fleet.ts";
import { workspaceSource } from "../src/runtime/workspace-source.ts";
import { Shell } from "../src/ui/Shell.tsx";
import { Onboarding } from "../src/ui/components/Onboarding.tsx";
import { MotionContext } from "../src/ui/components/motion.ts";
import { mnemoEnv } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close().catch(() => {});
});
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const lines = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
function fits(frame: string | undefined, w: number, h: number, what: string) {
  const ls = lines(frame);
  expect({ what, tooWide: ls.filter((l) => Bun.stringWidth(l) > w).length, tooTall: ls.length > h }).toEqual({ what, tooWide: 0, tooTall: false });
  return ls;
}
const source = { files: () => ["README.md", "src/a/deeply/nested/path/to/a-component-with-a-long-name.tsx"], memory: async () => [], sessions: async () => [], skills: () => [], logs: () => [], preview: async () => ({ title: "", lines: [] }), act: () => {} };
const SIZES = [[30, 10], [44, 14], [60, 20], [80, 24], [120, 36], [200, 50]] as const;

test("the workspace fits every size, with its header and composer, and the footer stays one line", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  e.faux.setResponses([
    fauxAssistantMessage([fauxText("Reading it."), fauxToolCall("bash", { command: `echo ${"x".repeat(160)}` })], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText(`${"word ".repeat(60)}\n\n\`\`\`ts\nexport const a = "${"y".repeat(120)}";\n\`\`\`\n\n| one | two | a much longer third header |\n|---|---|---|\n| a | b | c |\n\nhttps://example.com/${"long/".repeat(20)}`)),
  ]);
  await e.controller.submit(`do the thing ${"and more ".repeat(10)}`);
  await e.idle();
  for (const [w, h] of SIZES) {
    const r = render(React.createElement(Workspace, { controller: e.controller, source, motion: false, width: w, height: h }));
    await wait();
    const ls = fits(r.lastFrame(), w, h, `workspace ${w}x${h}`);
    expect(ls[0]).toContain("mnemo");
    expect(ls.some((l) => l.includes("❯"))).toBe(true);
    // The footer is the last line, and the box above it closes on the line before.
    expect(ls.at(-2)).toMatch(/^╰─+╯$/);
    r.unmount();
  }
}, 60000);

test("the hub, the split and a long approval fit; a split too small for its panes shows one agent", async () => {
  const spawn = async (cwd: string, exit: (c?: number) => void) => {
    const e = await mnemoEnv({ cwd });
    envs.push(e);
    (e.controller as unknown as { options: { exit: (c?: number) => void } }).options.exit = exit;
    return { controller: e.controller, host: e.host, source: workspaceSource(e.controller, e.host, e.home) };
  };
  const fleet = new Fleet(spawn, { onEmpty: () => {} });
  for (const n of ["alpha", "a-project-with-a-rather-long-name", "gamma"]) {
    const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-layout-")), n);
    fs.mkdirSync(d);
    await fleet.open(d);
  }
  for (const [w, h] of SIZES) {
    for (const view of ["hub", "split", "approval"] as const) {
      const r = render(React.createElement(Shell, { fleet, motion: false }));
      Object.defineProperty(r.stdout, "columns", { get: () => w, configurable: true });
      Object.defineProperty(r.stdout, "rows", { get: () => h, configurable: true });
      r.stdout.emit("resize");
      await wait();
      if (view === "hub") r.stdin.write("\x07");
      if (view === "split") r.stdin.write("\x13");
      if (view === "approval") void fleet.snapshot().agents[0]!.controller.dialogs.confirm(`Run ${"a long command ".repeat(6)}?`, "It is long. ".repeat(30));
      await wait(200);
      const ls = fits(r.lastFrame(), w, h, `${view} ${w}x${h}`);
      // The tab bar is one row at every width.
      expect(ls[1]).not.toContain("gamma ·");
      if (view === "split" && w < 80) expect(ls.join("\n")).toContain("too small to split");
      r.unmount();
      fleet.snapshot().agents[0]!.controller.dialogs.cancelAll();
    }
  }
}, 120000);

test("every page of the introduction fits", async () => {
  for (const [w, h] of SIZES) {
    for (let page = 0; page < 5; page++) {
      const o = render(React.createElement(MotionContext.Provider, { value: false }, React.createElement(Onboarding, { hasModel: false, onDone: () => {}, columns: w, rows: h, startAt: page, active: false })));
      await wait(20);
      fits(o.lastFrame(), w, h, `introduction page ${page + 1} at ${w}x${h}`);
      o.unmount();
    }
  }
});
