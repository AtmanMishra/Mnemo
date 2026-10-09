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
import { MemoryService } from "@mnemo/memory";
import { createHost, settleBackground, type Mode } from "../src/extensions/host.ts";
import { mnemoExtensions } from "../src/extensions/index.ts";
import { Root } from "../src/ui/Root.tsx";
import { workspaceSource } from "../src/runtime/workspace-source.ts";
import { runMemoryCommand } from "../src/memory-cli.ts";
import { Fleet } from "../src/runtime/fleet.ts";
import { exitLine } from "../src/ui/ExitCard.tsx";
import { applyTheme, themePaints, type ThemeName } from "../src/ui/theme.ts";
import { bestOf, describeBestOf } from "../src/runtime/best-of.ts";
import { selfCommand } from "../src/runtime/self.ts";

const USAGE = `mnemo ${pkg.version} — a coding agent with a memory

usage
  mnemo                    start in this folder
  mnemo -c, --continue     continue the most recent session here
  mnemo -p "<prompt>"      answer once and print the result (no interface)
  mnemo doctor             what is installed, configured and reachable
  mnemo memory …           memory for other agents: ingest Claude Code sessions (mnemo memory --help)
  mnemo --demo             a scripted session in a scratch project (no key needed)

options
  --cwd <dir>              work in another folder
  --plan                   start in plan mode (read-only)
  --accept-edits           change files in the project without asking (commands still ask)
  --yolo                   ask for nothing (deny rules in permissions.json still hold)
  --no-memory              run without the memory layer
  --no-reflect             do not extract facts after each run
  --no-verify              do not send a run that changed code back to run a check
  --best-of <n> --check <cmd>  with -p: run the task n times in separate worktrees, apply the smallest change that passes <cmd>
  --escalate <provider/id> after two failed checks in a run, finish it on this model ($MNEMO_ESCALATE_MODEL)
  --dump                   render one frame (after the demo turn, with --demo) and exit
  --no-motion              no animation
  --no-boot                skip the launch sequence
  --inline                 the transcript in the terminal's scrollback instead of the full-screen workspace
  --intro                  show the first-run introduction again
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
  boot: boolean;
  inline: boolean;
  intro: boolean;
  memory: boolean;
  reflect: boolean;
  verify: boolean;
  escalate?: string;
  bestOf?: number;
  check?: string;
  mode: Mode;
  continueRecent: boolean;
  print?: string;
  cwd?: string;
}

function parse(argv: string[]): Args {
  const a: Args = { help: false, version: false, demo: false, dump: false, motion: true, boot: true, inline: false, intro: false, memory: true, reflect: true, verify: true, escalate: process.env.MNEMO_ESCALATE_MODEL || undefined, mode: "default", continueRecent: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "doctor" && i === 0) a.command = "doctor";
    else if (v === "-h" || v === "--help") a.help = true;
    else if (v === "-v" || v === "--version") a.version = true;
    else if (v === "--demo") a.demo = true;
    else if (v === "--dump") a.dump = true;
    else if (v === "--no-motion") a.motion = false;
    else if (v === "--no-boot") a.boot = false;
    else if (v === "--inline") a.inline = true;
    else if (v === "--intro") a.intro = true;
    else if (v === "--no-memory") a.memory = false;
    else if (v === "--no-reflect") a.reflect = false;
    else if (v === "--no-verify") a.verify = false;
    else if (v === "--escalate") a.escalate = argv[++i];
    else if (v === "--best-of") a.bestOf = Number(argv[++i]);
    else if (v === "--check") a.check = argv[++i];
    else if (v === "--plan") a.mode = "plan";
    else if (v === "--accept-edits") a.mode = "accept-edits";
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

/** Small per-user state: whether the introduction has been seen. */
interface State {
  onboarded?: boolean;
  /** Folders agents were opened in, most recent first. */
  recent?: string[];
  theme?: ThemeName;
}

function readState(home: string): State {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
  } catch {
    return {};
  }
}

function writeState(home: string, state: State): void {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(state, null, 2));
  } catch {
    /* a lost flag only means the introduction shows again */
  }
}

/** What the launch sequence counts up: memories, skills, sessions. */
async function bootStats(memory: MemoryService, runtime: Awaited<ReturnType<typeof startRuntime>>) {
  const s = await memory.stats().catch(() => undefined);
  if (!s) return undefined;
  return { memories: s.nodes, skills: runtime.session.resourceLoader.getSkills().skills.length, sessions: s.episodes };
}

/** `-p --best-of n`: each candidate is this binary again, headless, in its own worktree. */
async function runBestOf(args: Args, home: string): Promise<number> {
  const n = args.bestOf!;
  if (args.print === undefined || !args.check || !Number.isInteger(n) || n < 2 || n > 8) {
    console.error('mnemo: --best-of takes 2–8 and needs -p "<task>" and --check "<command that passes when the task is done>"');
    return 2;
  }
  const self = selfCommand();
  const pass = [
    ...(args.mode !== "default" ? [`--${args.mode}`] : []),
    ...(args.memory ? [] : ["--no-memory"]),
    ...(args.escalate ? ["--escalate", args.escalate] : []),
  ];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const result = await bestOf({
    n,
    cwd: path.resolve(args.cwd ?? process.cwd()),
    check: args.check,
    keepDir: path.join(home, "best-of", stamp),
    // Candidates do not reflect: n copies of one lesson would only add noise.
    run: async (i, cwd) => {
      console.error(`candidate ${i + 1} started`);
      const p = Bun.spawn([...self, "-p", args.print!, "--cwd", cwd, "--no-reflect", ...pass], { cwd, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      console.error(`candidate ${i + 1} finished (${code === 0 ? "ok" : `exit ${code}`})`);
      if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `exit ${code}`);
      return out.trim();
    },
  });
  console.log(describeBestOf(result));
  return result.winner ? 0 : 1;
}

async function main(): Promise<number> {
  if (process.argv[2] === "memory") {
    const home = mnemoHome();
    pointPiAt(agentDir(home));
    return runMemoryCommand(process.argv.slice(3), home, agentDir(home));
  }
  const args = parse(process.argv.slice(2));
  if (args.help) return console.log(USAGE), 0;
  if (args.version) return console.log(pkg.version), 0;

  const home = mnemoHome();
  const dir = agentDir(home);
  fs.mkdirSync(dir, { recursive: true });
  pointPiAt(dir);
  if (args.command === "doctor") return doctor(home, dir);
  if (args.bestOf !== undefined) return runBestOf(args, home);

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
    // A dump has nobody to answer an approval: the demo runs its check unasked.
    if (args.dump && args.mode === "default") args.mode = "yolo";
  }
  modelRuntime ??= await createModelRuntime(dir);

  const memsrv = args.memory ? findMemsrv(home) : undefined;
  const memory = memsrv ? new MemoryService(memsrv, journal) : undefined;
  const runtimeModels = modelRuntime;
  /** One agent's host and pi session in `agentCwd`; the first gets --continue and the demo's injections. */
  const makeAgent = async (agentCwd: string, first = false) => {
    const host = createHost({ home, agentDir: dir, modelRuntime: runtimeModels, memory, mode: args.mode, reflect: args.reflect, verify: args.verify, escalate: args.escalate });
    const runtime = await startRuntime({
      cwd: agentCwd,
      agentDir: dir,
      modelRuntime: runtimeModels,
      continueRecent: first && args.continueRecent,
      extensions: mnemoExtensions(host),
      ...(first ? injected : {}),
    });
    return { host, runtime };
  };
  const { host, runtime } = await makeAgent(cwd, true);

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
  const state = readState(home);
  applyTheme(state.theme ?? "night");
  const saveTheme = (theme: ThemeName) => writeState(home, { ...readState(home), theme });
  // Every agent of this process. The program ends when the last one closes.
  const fleet = new Fleet(
    async (agentCwd, exit) => {
      const made = await makeAgent(agentCwd);
      const c = new Controller(made.runtime, { exit, onClearScreen: clearTerminal, host: made.host, onTheme: saveTheme });
      await c.bind();
      c.transcript.push({ kind: "welcome" });
      return { controller: c, host: made.host, source: workspaceSource(c, made.host, home) };
    },
    {
      onEmpty: (code) => {
        exitCode = code;
        // The exit card shows for a moment before the screen goes.
        setTimeout(finished, interactive && layout === "workspace" && args.motion ? 1400 : 0);
      },
      recent: state.recent,
      saveRecent: (recent) => writeState(home, { ...readState(home), recent }),
    },
  );
  let firstId = 0;
  const controller = new Controller(runtime, { exit: (code) => fleet.closed(firstId, code ?? 0), onClearScreen: clearTerminal, host, onTheme: saveTheme });
  await controller.bind();
  controller.transcript.push({ kind: "welcome" });
  firstId = fleet.adopt(cwd, { controller, host, source: workspaceSource(controller, host, home) }).id;
  if (!memsrv && args.memory)
    controller.transcript.notice(`Memory is off: ${memsrvName()} was not found. \`mnemo doctor\` says where it looks.`, "warn");
  if (args.continueRecent && runtime.session.messages.length > 0) {
    controller.transcript.load(runtime.session.messages);
    controller.transcript.notice("Continuing the most recent session");
  }

  // A terminal gets the workspace (full screen, alternate buffer) unless --inline; a dump or a pipe the inline transcript.
  const layout = interactive && !args.inline ? "workspace" : "inline";
  const onboard = interactive && !args.demo && (args.intro || !state.onboarded);
  const stats = memory ? await bootStats(memory, runtime) : undefined;
  instance = render(
    React.createElement(Root, {
      controller,
      fleet,
      version: pkg.version,
      home: os.homedir(),
      motion: args.motion && interactive,
      layout,
      boot: interactive && args.boot,
      onboard,
      stats,
      clearTerminal,
      onOnboarded: (choice) => {
        writeState(home, { ...state, onboarded: true });
        if (choice === "login") void controller.submit("/login");
        if (choice === "demo") controller.transcript.notice("For a scripted tour with no key: quit, then run `mnemo --demo`.");
      },
    }),
    {
      exitOnCtrlC: false,
      patchConsole: true,
      kittyKeyboard: { mode: "auto" },
      alternateScreen: layout === "workspace",
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
  // A painted theme changed the terminal's default colours: give them back.
  if (interactive && themePaints()) process.stdout.write("\x1b]110\x07\x1b]111\x07");
  if (interactive && layout === "workspace") process.stdout.write(`${exitLine(fleet.snapshot().summary)}\n`);
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
