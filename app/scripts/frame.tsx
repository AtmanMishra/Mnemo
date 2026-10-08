#!/usr/bin/env bun
/**
 * One frame of a screen, printed once — for snapshots and design review.
 *
 *   FORCE_COLOR=3 bun scripts/frame.tsx boot 650 | bun scripts/snapshot.ts boot.png
 *   bun scripts/frame.tsx boot <ms> [--cols 100 --rows 28]
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

const argv = process.argv.slice(2);
const opt = (n: string, d: number) => (argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d);
const columns = opt("--cols", 100);
const rows = opt("--rows", 28);
Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });

const [screen, arg] = argv;
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
} else throw new Error(`unknown screen ${screen}`);

// A keyboard that never types: screens that listen for keys need a TTY-like stdin.
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream;
const { unmount } = render(<MotionContext.Provider value={false}>{el}</MotionContext.Provider>, { interactive: false, stdin });
// Let measured layout (the workspace's viewport) and loaded panes settle before the one frame is written.
await new Promise((r) => setTimeout(r, 400));
unmount();
process.exit(0);
