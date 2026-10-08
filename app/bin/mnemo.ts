#!/usr/bin/env bun
/**
 * `mnemo` — the entry point, and the only place that touches the process:
 * arguments, the terminal, exit codes. Everything else takes what it needs as
 * parameters, so it can be tested without any of these.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import { agentDir, findMemsrv, journalPath, memsrvName, mnemoHome, pointPiAt, skillsDir } from "../src/runtime/paths.ts";
import { createModelRuntime, startRuntime } from "../src/runtime/runtime.ts";
import { Controller } from "../src/runtime/controller.ts";
import { createDemoProject, createFaux, demoScript, DEMO_PROMPT } from "../src/runtime/demo.ts";
import { MemoryService } from "../src/memory/service.ts";
import { createHost, settleBackground, type Mode } from "../src/extensions/host.ts";
import { mnemoExtensions } from "../src/extensions/index.ts";
import { App } from "../src/ui/App.tsx";

const USAGE = `mnemo ${pkg.version} — a coding agent with a memory

usage
  mnemo                    start in this folder
  mnemo -c, --continue     continue the most recent session here
  mnemo -p "<prompt>"      answer once and print the result (no interface)
  mnemo doctor             what is installed, configured and reachable
  mnemo --demo             a scripted session in a scratch project (no key needed)

options
  --cwd <dir>              work in another folder
  --plan                   start in plan mode (read-only)
  --yolo                   ask for nothing (deny rules in permissions.json still hold)
  --no-memory              run without the memory layer
  --no-reflect             do not extract facts after each run
  --dump                   render one frame (after the demo turn, with --demo) and exit
  --no-motion              no animation
  -v, --version            print the version
  -h, --help               this text

state lives in $MNEMO_HOME (default ~/.mnemo); pi's files are in $MNEMO_HOME/agent`;

interface Args {
  command?: "doctor";
  help: boolean;
  version: boolean;
  demo: boolean;
  dump: boolean;
  motion: boolean;
  memory: boolean;
  reflect: boolean;
  mode: Mode;
  continueRecent: boolean;
  print?: string;
  cwd?: string;
}

function parse(argv: string[]): Args {
  const a: Args = { help: false, version: false, demo: false, dump: false, motion: true, memory: true, reflect: true, mode: "default", continueRecent: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "doctor" && i === 0) a.command = "doctor";
    else if (v === "-h" || v === "--help") a.help = true;
    else if (v === "-v" || v === "--version") a.version = true;
    else if (v === "--demo") a.demo = true;
    else if (v === "--dump") a.dump = true;
    else if (v === "--no-motion") a.motion = false;
    else if (v === "--no-memory") a.memory = false;
    else if (v === "--no-reflect") a.reflect = false;
    else if (v === "--plan") a.mode = "plan";
    else if (v === "--yolo") a.mode = "yolo";
    else if (v === "-c" || v === "--continue") a.continueRecent = true;
    else if (v === "-p" || v === "--print") a.print = argv[++i] ?? "";
    else if (v === "--cwd") a.cwd = argv[++i];
    else throw new Error(`unknown argument ${v} — mnemo --help lists them`);
  }
  return a;
}

/** A stdin that never sends a key, for frames rendered without a terminal. */
function silentStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  s.isTTY = true;
  s.setRawMode = () => s;
  return s;
}

async function doctor(home: string, dir: string): Promise<number> {
  const ok = (b: boolean) => (b ? "✓" : "✗");
  const lines: string[] = [`mnemo ${pkg.version} · bun ${Bun.version} · ${process.platform}-${process.arch}`, `home    ${home}`];
  const runtime = await startRuntime({ cwd: process.cwd(), agentDir: dir, sessionManager: SessionManager.inMemory(process.cwd()) });
  const model = runtime.session.model;
  const usable = !!model && runtime.session.modelRuntime.hasConfiguredAuth(model.provider);
  lines.push(`${ok(usable)} model   ${usable ? `${model!.provider}/${model!.id}` : "none — run mnemo, then /login"}`);
  await runtime.dispose();
  const memsrv = findMemsrv(home);
  if (memsrv) {
    const mem = new MemoryService(memsrv, journalPath(home));
    const stats = await mem.stats();
    mem.stop();
    lines.push(`${ok(!!stats)} memory  ${memsrv}${stats ? ` · ${stats.nodes} nodes · ${journalPath(home)}` : " (did not answer)"}`);
  } else {
    lines.push(`✗ memory  ${memsrvName()} not found — put it in ${path.join(home, "bin")} or set MNEMO_MEMSRV (cargo build --release --bin memsrv)`);
  }
  const python = createHost({ home, agentDir: dir, modelRuntime: runtime.session.modelRuntime }).python();
  lines.push(`${ok(!!python)} python  ${python ?? "not found — ipy_run is disabled (set MNEMO_PYTHON)"}`);
  let skills = 0;
  try {
    skills = fs.readdirSync(skillsDir(home)).length;
  } catch {
    /* none */
  }
  lines.push(`  skills  ${skills} in ${skillsDir(home)}`);
  console.log(lines.join("\n"));
  return usable && memsrv ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (args.help) return console.log(USAGE), 0;
  if (args.version) return console.log(pkg.version), 0;

  const home = mnemoHome();
  const dir = agentDir(home);
  fs.mkdirSync(dir, { recursive: true });
  pointPiAt(dir);
  if (args.command === "doctor") return doctor(home, dir);

  let cwd = path.resolve(args.cwd ?? process.cwd());
  let modelRuntime = undefined as Awaited<ReturnType<typeof createModelRuntime>> | undefined;
  let injected: Partial<Parameters<typeof startRuntime>[0]> = {};
  let journal = journalPath(home);
  if (args.demo) {
    cwd = createDemoProject();
    // The demo learns into a scratch journal, never into your real memory.
    journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-demo-memory-")), "journal.jsonl");
    const faux = await createFaux(dir, { tokensPerSecond: args.dump ? undefined : 90 });
    faux.faux.setResponses(demoScript());
    modelRuntime = faux.modelRuntime;
    injected = { model: faux.faux.getModel(), sessionManager: SessionManager.inMemory(cwd) };
    if (args.dump && args.mode === "default") args.mode = "accept-edits";
  }
  modelRuntime ??= await createModelRuntime(dir);

  const memsrv = args.memory ? findMemsrv(home) : undefined;
  const memory = memsrv ? new MemoryService(memsrv, journal) : undefined;
  const host = createHost({ home, agentDir: dir, modelRuntime, memory, mode: args.mode, reflect: args.reflect });
  const runtime = await startRuntime({
    cwd,
    agentDir: dir,
    modelRuntime,
    continueRecent: args.continueRecent,
    extensions: mnemoExtensions(host),
    ...injected,
  });

  if (args.print !== undefined) {
    const session = runtime.session;
    await session.bindExtensions({});
    try {
      if (!session.model || !session.modelRuntime.hasConfiguredAuth(session.model.provider)) {
        console.error("mnemo: no model configured — run mnemo and use /login, then /model");
        return 1;
      }
      await session.prompt(args.print);
      process.stdout.write(`${session.getLastAssistantText() ?? ""}\n`);
      await settleBackground(host);
      return 0;
    } finally {
      await runtime.dispose();
      memory?.stop();
    }
  }

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !args.dump;
  let instance: ReturnType<typeof render> | undefined;
  const clearTerminal = () => {
    instance?.clear();
    if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  };
  let exitCode = 0;
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));
  const controller = new Controller(runtime, {
    exit: (code) => {
      exitCode = code ?? 0;
      finished();
    },
    onClearScreen: clearTerminal,
    host,
  });
  await controller.bind();
  controller.transcript.push({ kind: "welcome" });
  if (!memsrv && args.memory)
    controller.transcript.notice(`Memory is off: ${memsrvName()} was not found. \`mnemo doctor\` says where it looks.`, "warn");
  if (args.continueRecent && runtime.session.messages.length > 0) {
    controller.transcript.load(runtime.session.messages);
    controller.transcript.notice("Continuing the most recent session");
  }

  instance = render(
    React.createElement(App, { controller, version: pkg.version, home: os.homedir(), motion: args.motion && interactive, clearTerminal }),
    {
      exitOnCtrlC: false,
      patchConsole: true,
      kittyKeyboard: { mode: "auto" },
      ...(interactive ? {} : { stdin: silentStdin(), interactive: false }),
    },
  );

  if (args.demo) setTimeout(() => void controller.submit(DEMO_PROMPT), args.dump ? 0 : 900);
  if (args.dump) {
    if (args.demo) {
      await new Promise((r) => setTimeout(r, 50));
      await runtime.session.waitForIdle();
      await settleBackground(host);
      await new Promise((r) => setTimeout(r, 50));
    }
    await instance.waitUntilRenderFlush();
    await controller.quit();
  }

  await done;
  memory?.stop();
  instance.unmount();
  await instance.waitUntilExit().catch(() => {});
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`mnemo: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
