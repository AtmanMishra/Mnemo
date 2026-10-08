/**
 * The shell on real sessions: agents in a fleet, the hub, the split, the
 * project picker, and moving between agents with the keyboard. Closing the
 * last agent ends the program.
 */
import { test, expect, afterEach } from "bun:test";
import React from "react";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "ink-testing-library";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { Fleet, projectCandidates } from "../src/runtime/fleet.ts";
import { workspaceSource } from "../src/runtime/workspace-source.ts";
import { Shell, splitGrid } from "../src/ui/Shell.tsx";
import { matchProject } from "../src/ui/ProjectPicker.tsx";
import { turns, testCounts } from "../src/ui/activity.ts";
import { mnemoEnv } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close().catch(() => {});
});
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const KEY = { ctrlG: "\x07", ctrlP: "\x10", ctrlS: "\x13", ctrlN: "\x0e", alt: (k: string) => `\x1b${k}`, esc: "\x1b", enter: "\r" };

function project(name: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-shell-")), name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

async function fleetOf(names: string[]) {
  let ended: number | undefined;
  const spawn = async (cwd: string, exit: (code?: number) => void) => {
    const e = await mnemoEnv({ cwd });
    envs.push(e);
    // The env's controller has its own exit; route quits to the fleet like the real one.
    (e.controller as unknown as { options: { exit: (c?: number) => void } }).options.exit = exit;
    return { controller: e.controller, host: e.host, source: workspaceSource(e.controller, e.host, e.home) };
  };
  const fleet = new Fleet(spawn, { onEmpty: (c) => (ended = c) });
  for (const n of names) await fleet.open(project(n));
  return { fleet, ended: () => ended };
}

test("the tab bar names every agent; alt+2 goes to the second", async () => {
  const { fleet } = await fleetOf(["alpha", "beta"]);
  const r = render(React.createElement(Shell, { fleet, motion: false }));
  await wait();
  expect(r.lastFrame()).toContain("1 alpha");
  expect(r.lastFrame()).toContain("2 beta");
  const agents = fleet.snapshot().agents;
  agents[1]!.controller.transcript.notice("this is beta speaking");
  r.stdin.write(KEY.alt("2"));
  await wait();
  expect(r.lastFrame()).toContain("this is beta speaking");
  r.unmount();
});

test("ctrl+g opens the hub with a card per agent; enter opens the chosen one", async () => {
  const { fleet } = await fleetOf(["alpha", "beta"]);
  const r = render(React.createElement(Shell, { fleet, motion: false }));
  await wait();
  r.stdin.write(KEY.ctrlG);
  await wait();
  expect(r.lastFrame()).toContain("2 open");
  expect(r.lastFrame()).toContain("alpha");
  expect(r.lastFrame()).toContain("new · ready");
  r.stdin.write("\x1b[C"); // → beta
  await wait();
  fleet.snapshot().agents[1]!.controller.transcript.notice("beta opened");
  r.stdin.write(KEY.enter);
  await wait();
  expect(r.lastFrame()).toContain("beta opened");
  r.unmount();
});

test("ctrl+s splits the screen between the agents, and a turn in one shows only there", async () => {
  const { fleet } = await fleetOf(["alpha", "beta"]);
  const r = render(React.createElement(Shell, { fleet, motion: false }));
  await wait();
  r.stdin.write(KEY.ctrlS);
  await wait();
  const [a, b] = fleet.snapshot().agents;
  const env = envs.find((e) => e.controller === b!.controller)!;
  env.faux.setResponses([fauxAssistantMessage(fauxText("beta's answer"))]);
  await b!.controller.submit("hello beta");
  await env.idle();
  await wait(150);
  const frame = r.lastFrame()!;
  expect(frame).toContain("alpha");
  expect(frame).toContain("beta's answer");
  expect(a!.controller.transcript.snapshot().committed.some((x) => x.kind === "assistant")).toBe(false);
  r.unmount();
});

test("ctrl+p lists open and recent projects; enter on an open one switches to it", async () => {
  const { fleet } = await fleetOf(["alpha", "beta"]);
  const r = render(React.createElement(Shell, { fleet, motion: false }));
  await wait();
  r.stdin.write(KEY.ctrlP);
  await wait();
  expect(r.lastFrame()).toContain("projects");
  r.stdin.write("bet");
  await wait();
  fleet.snapshot().agents[1]!.controller.transcript.notice("arrived at beta");
  r.stdin.write(KEY.enter);
  await wait(150);
  expect(r.lastFrame()).not.toContain("type a name");
  expect(r.lastFrame()).toContain("arrived at beta");
  expect(fleet.snapshot().agents).toHaveLength(2);
  r.unmount();
});

test("ctrl+n starts a second agent on the same project; closing every agent ends the program", async () => {
  const { fleet, ended } = await fleetOf(["alpha"]);
  const r = render(React.createElement(Shell, { fleet, motion: false }));
  await wait();
  r.stdin.write(KEY.ctrlN);
  await wait(400);
  const agents = fleet.snapshot().agents;
  expect(agents.map((a) => a.name)).toEqual(["alpha", "alpha·2"]);
  expect(agents[0]!.cwd).toBe(agents[1]!.cwd);
  await fleet.close(agents[0]!.id);
  expect(ended()).toBeUndefined();
  await fleet.close(agents[1]!.id);
  expect(ended()).toBe(0);
  r.unmount();
});

test("pure parts: the split grid, project matching and candidates, turns and test counts", () => {
  expect(splitGrid(2, 120)).toEqual({ cols: 2, rows: 1 });
  expect(splitGrid(3, 120)).toEqual({ cols: 2, rows: 2 });
  expect(splitGrid(3, 200)).toEqual({ cols: 3, rows: 1 });
  expect(matchProject("/code/self-evolving-agent", "sea")).toBe(true);
  expect(matchProject("/code/clsx", "zz")).toBe(false);
  const a = project("one");
  expect(projectCandidates({ agents: [], recent: [a] }, a)[0]).toBe(a);

  const blocks = [
    { kind: "user", id: "1", text: "first" },
    { kind: "tool", id: "2", name: "bash", args: {}, status: "error", output: "" },
    { kind: "user", id: "3", text: "second" },
    { kind: "tool", id: "4", name: "bash", args: {}, status: "done", output: "" },
    { kind: "user", id: "5", text: "third" },
  ] as const;
  expect(turns(blocks as never, true).map((t) => t.outcome)).toEqual(["failed", "ok", "running"]);

  expect(testCounts(" 12 pass\n 1 fail\n")).toEqual({ passed: 12, failed: 1, skipped: 0 });
  expect(testCounts("===== 3 passed, 1 failed in 0.2s =====")).toEqual({ passed: 3, failed: 1, skipped: 0 });
  expect(testCounts("test result: ok. 9 passed; 0 failed; 0 ignored")).toEqual({ passed: 9, failed: 0, skipped: 0 });
  expect(testCounts("ok  \tpkg/a\t0.1s\nFAIL\tpkg/b\t0.2s")).toEqual({ passed: 1, failed: 1, skipped: 0 });
  expect(testCounts("hello world")).toBeUndefined();
});
