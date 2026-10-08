#!/usr/bin/env bun
/**
 * One frame of a screen, printed once — for snapshots and design review.
 *
 *   FORCE_COLOR=3 bun scripts/frame.tsx boot 650 | bun scripts/snapshot.ts boot.png
 *   bun scripts/frame.tsx boot <ms> [--cols 100 --rows 28] [--theme paper]
 *   bun scripts/frame.tsx shell hub:3            the hub with three agents
 *   bun scripts/frame.tsx shell split:3 | agent:2 | picker:2
 */
import React from "react";
import { render } from "ink";
import { Boot } from "../src/ui/components/Boot.tsx";
import { Onboarding } from "../src/ui/components/Onboarding.tsx";
import { MotionContext } from "../src/ui/components/motion.ts";
import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findMemsrv, MemoryService } from "@mnemo/memory";
import { agentDir, pointPiAt } from "../src/runtime/paths.ts";
import { startRuntime } from "../src/runtime/runtime.ts";
import { Controller } from "../src/runtime/controller.ts";
import { createDemoProject, createFaux, demoScript, DEMO_PROMPT } from "../src/runtime/demo.ts";
import { createHost, settleBackground } from "../src/extensions/host.ts";
import { mnemoExtensions } from "../src/extensions/index.ts";
import { workspaceSource } from "../src/runtime/workspace-source.ts";
import { Workspace, type Focus } from "../src/ui/workspace/Workspace.tsx";
import type { Pane } from "../src/ui/workspace/model.ts";
import { Fleet } from "../src/runtime/fleet.ts";
import { Shell, type Screen } from "../src/ui/Shell.tsx";
import { applyTheme, type ThemeName } from "../src/ui/theme.ts";

const argv = process.argv.slice(2);
const opt = (n: string, d: number) => (argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d);
const columns = opt("--cols", 100);
const rows = opt("--rows", 28);
Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });

if (argv.includes("--theme")) applyTheme(argv[argv.indexOf("--theme") + 1] as ThemeName);
const [screen, arg] = argv;

/** A demo agent: its own scratch project, the faux model, optionally one scripted turn done. */
async function demoAgent(home: string, turn: boolean) {
  const dir = agentDir(home);
  pointPiAt(dir);
  const cwd = createDemoProject();
  const faux = await createFaux(dir);
  faux.faux.setResponses(demoScript());
  const memsrv = findMemsrv(home);
  const memory = memsrv ? new MemoryService(memsrv, path.join(home, "journal.jsonl")) : undefined;
  const host = createHost({ home, agentDir: dir, modelRuntime: faux.modelRuntime, memory, mode: "yolo" });
  const runtime = await startRuntime({ cwd, agentDir: dir, modelRuntime: faux.modelRuntime, model: faux.faux.getModel(), sessionManager: SessionManager.inMemory(cwd), extensions: mnemoExtensions(host) });
  const controller = new Controller(runtime, { exit: () => {}, host });
  await controller.bind();
  if (turn) {
    await controller.submit(DEMO_PROMPT);
    await controller.session.waitForIdle();
    await settleBackground(host);
  }
  return { cwd, controller, host, source: workspaceSource(controller, host, home) };
}
let el: React.ReactElement;
if (screen === "boot")
  el = <Boot at={Number(arg ?? 1600)} onDone={() => {}} info={{ version: "0.1.0", columns, rows, stats: { memories: 412, skills: 9, sessions: 37 } }} />;
else if (screen === "onboarding")
  el = <Onboarding startAt={Number(arg ?? 0)} active={false} hasModel={false} onDone={() => {}} columns={columns} rows={rows} />;
else if (screen === "workspace") {
  // A demo project, one scripted turn, then the workspace as asked: focus/pane/selected.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-frame-"));
  const dir = agentDir(home);
  pointPiAt(dir);
  const cwd = createDemoProject();
  const faux = await createFaux(dir);
  faux.faux.setResponses(demoScript());
  const memsrv = findMemsrv(home);
  const memory = memsrv ? new MemoryService(memsrv, path.join(home, "journal.jsonl")) : undefined;
  const host = createHost({ home, agentDir: dir, modelRuntime: faux.modelRuntime, memory, mode: "yolo" });
  const runtime = await startRuntime({ cwd, agentDir: dir, modelRuntime: faux.modelRuntime, model: faux.faux.getModel(), sessionManager: SessionManager.inMemory(cwd), extensions: mnemoExtensions(host) });
  const controller = new Controller(runtime, { exit: () => {}, host });
  await controller.bind();
  await controller.submit(DEMO_PROMPT);
  await controller.session.waitForIdle();
  await settleBackground(host);
  const [focus, pane, sel] = (arg ?? "composer").split(":");
  el = (
    <Workspace
      controller={controller}
      source={workspaceSource(controller, host, home)}
      motion={false}
      initial={{ focus: focus as Focus, pane: (pane as Pane) ?? "files", selected: sel ? Number(sel) : undefined, openDirs: ["src"] }}
    />
  );
} else if (screen === "shell") {
  const [mode, count] = (arg ?? "agent:1").split(":");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-frame-"));
  const fleet = new Fleet(async () => {
    throw new Error("frames do not open agents");
  }, { onEmpty: () => {} });
  for (let i = 0; i < Number(count ?? 1); i++) {
    const a = await demoAgent(home, i < 2);
    fleet.adopt(a.cwd, a);
  }
  const picker = mode === "picker";
  el = <Shell fleet={fleet} motion={false} initial={{ screen: (picker ? "agent" : mode) as Screen, picker }} />;
} else throw new Error(`unknown screen ${screen}`);

// A keyboard that never types: screens that listen for keys need a TTY-like stdin.
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream;
const { unmount } = render(<MotionContext.Provider value={false}>{el}</MotionContext.Provider>, { interactive: false, stdin });
// Let measured layout (the workspace's viewport) and loaded panes settle before the one frame is written.
await new Promise((r) => setTimeout(r, 400));
unmount();
process.exit(0);
