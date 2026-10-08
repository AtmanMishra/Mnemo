#!/usr/bin/env bun
/**
 * `mnemo` — the entry point, and the only place that touches the process:
 * arguments, the terminal, exit codes. Everything else takes what it needs as
 * parameters, so it can be tested without any of these.
 */
import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import { agentDir, mnemoHome, pointPiAt } from "../src/runtime/paths.ts";
import { startRuntime } from "../src/runtime/runtime.ts";
import { Controller } from "../src/runtime/controller.ts";
import { createDemoProject, createFaux, demoScript, DEMO_PROMPT } from "../src/runtime/demo.ts";
import { App } from "../src/ui/App.tsx";

const USAGE = `mnemo ${pkg.version} — a coding agent with a memory

usage
  mnemo                    start in this folder
  mnemo -c, --continue     continue the most recent session here
  mnemo -p "<prompt>"      answer once and print the result (no interface)
  mnemo --demo             a scripted session in a scratch project (no key needed)
  mnemo --cwd <dir>        work in another folder

options
  --dump                   render one frame (after the demo turn, with --demo) and exit
  --no-motion              no animation
  -v, --version            print the version
  -h, --help               this text

state lives in $MNEMO_HOME (default ~/.mnemo); pi's files are in $MNEMO_HOME/agent`;

interface Args {
  help: boolean;
  version: boolean;
  demo: boolean;
  dump: boolean;
  motion: boolean;
  continueRecent: boolean;
  print?: string;
  cwd?: string;
}

function parse(argv: string[]): Args {
  const a: Args = { help: false, version: false, demo: false, dump: false, motion: true, continueRecent: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "-h" || v === "--help") a.help = true;
    else if (v === "-v" || v === "--version") a.version = true;
    else if (v === "--demo") a.demo = true;
    else if (v === "--dump") a.dump = true;
    else if (v === "--no-motion") a.motion = false;
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

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (args.help) return console.log(USAGE), 0;
  if (args.version) return console.log(pkg.version), 0;

  const home = mnemoHome();
  const dir = agentDir(home);
  fs.mkdirSync(dir, { recursive: true });
  pointPiAt(dir);

  let cwd = args.cwd ?? process.cwd();
  let injected: Partial<Parameters<typeof startRuntime>[0]> = {};
  if (args.demo) {
    cwd = createDemoProject();
    const { modelRuntime, faux } = await createFaux(dir, { tokensPerSecond: args.dump ? undefined : 90 });
    faux.setResponses(demoScript());
    injected = { modelRuntime, model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd) };
  }
  const runtime = await startRuntime({ cwd, agentDir: dir, continueRecent: args.continueRecent, ...injected });

  if (args.print !== undefined) {
    const session = runtime.session;
    await session.bindExtensions({});
    if (!session.model || !session.modelRuntime.hasConfiguredAuth(session.model.provider)) {
      console.error("mnemo: no model configured — run mnemo and use /login, then /model");
      await runtime.dispose();
      return 1;
    }
    try {
      await session.prompt(args.print);
      process.stdout.write(`${session.getLastAssistantText() ?? ""}\n`);
      return 0;
    } finally {
      await runtime.dispose();
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
  });
  await controller.bind();
  controller.transcript.push({ kind: "welcome" });
  if (args.continueRecent && runtime.session.messages.length > 0) {
    controller.transcript.load(runtime.session.messages);
    controller.transcript.notice("Continuing the most recent session");
  }

  instance = render(
    React.createElement(App, { controller, version: pkg.version, home: process.env.HOME ?? "", motion: args.motion && interactive, clearTerminal }),
    {
      exitOnCtrlC: false,
      patchConsole: true,
      kittyKeyboard: { mode: "auto" },
      ...(interactive ? {} : { stdin: silentStdin(), interactive: false }),
    },
  );

  if (args.demo) {
    setTimeout(() => void controller.submit(DEMO_PROMPT), args.dump ? 0 : 900);
  }
  if (args.dump) {
    if (args.demo) {
      await new Promise((r) => setTimeout(r, 50));
      await runtime.session.waitForIdle();
    }
    await instance.waitUntilRenderFlush();
    await controller.quit();
  }

  await done;
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
