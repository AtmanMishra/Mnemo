#!/usr/bin/env bun
/**
 * `mnemo` — the entry point, and the only place that touches the process:
 * arguments, the terminal, exit codes. Everything else takes what it needs as
 * parameters, so it can be tested without any of these.
 */
// First: a compiled binary cannot load pi's login flows or Bedrock until this registers them.
import "../src/runtime/bun-setup.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { hasTrustRequiringProjectResources, ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import * as readline from "node:readline/promises";
import pkg from "../package.json" with { type: "json" };
import { agentDir, findMemsrv, journalPath, memsrvName, mnemoHome, pointPiAt, skillsDir } from "../src/runtime/paths.ts";
import { createModelRuntime, startRuntime } from "../src/runtime/runtime.ts";
import { allowedMode, loadManaged, managedPath } from "../src/policy/managed.ts";
import { Controller, type Updater } from "../src/runtime/controller.ts";
import { createDemoProject, createFaux, demoScript, DEMO_PROMPT } from "../src/runtime/demo.ts";
import { MemoryService } from "@mnemo/memory";
import { createHost, settleBackground, type Mode } from "../src/extensions/host.ts";
import { mnemoExtensions } from "../src/extensions/index.ts";
import { Root } from "../src/ui/Root.tsx";
import { RpcServer } from "../src/runtime/rpc.ts";
import { workspaceSource } from "../src/runtime/workspace-source.ts";
import { runMemoryCommand } from "../src/memory-cli.ts";
import { scheduleCommand } from "../src/schedule/cli.ts";
import { Fleet } from "../src/runtime/fleet.ts";
import { Roster } from "../src/runtime/roster.ts";
import { exitLine } from "../src/ui/ExitCard.tsx";
import { applyTheme, themePaints, type ThemeName } from "../src/ui/theme.ts";
import { mouse } from "../src/ui/mouse.ts";
import { FOCUS_OFF, FOCUS_ON, Notifier } from "../src/ui/notify.ts";
import { setLinks } from "../src/ui/link.ts";
import { clearReplaced, compareVersions, installKind, latestVersion, manualStep, runInstaller, shouldCheck } from "../src/runtime/update.ts";
import { bestOf, describeBestOf } from "../src/runtime/best-of.ts";
import { selfCommand } from "../src/runtime/self.ts";
import { openSettings } from "../src/runtime/settings.ts";
import { settingsCommand } from "../src/runtime/settings-menu.ts";
import { checkMemory, envHints, findProblems } from "../src/runtime/doctor.ts";
import { chooseModel } from "../src/runtime/model-choice.ts";
import { describePlan, looksLikeMnemoHome, planUninstall, runUninstall } from "../src/runtime/uninstall.ts";
import { mayOffer, ownConsole, placementProblems, selfInstall, selfInstallOffer } from "../src/runtime/self-install.ts";

const USAGE = `mnemo ${pkg.version} — a coding agent with a memory

usage
  mnemo                    start in this folder
  mnemo -c, --continue     continue the most recent session here
  mnemo -p "<prompt>"      answer once and print the result (no interface); asks nothing: what would ask
                           is allowed, while deny rules and --plan still refuse
  mnemo doctor [--fix]     what is installed, configured and reachable; --fix repairs what it can
  mnemo install [--yes]    put this copy in $MNEMO_HOME/bin and on your PATH (a downloaded mnemo.exe offers it)
  mnemo update             install the latest release · --check · --auto on|off (a daily check, off by default)
  mnemo uninstall          remove Mnemo; what it learned stays · --deep also deletes memory, sessions,
                           credentials and settings · --yes skips the question
  mnemo settings …         every setting: list, get <name>, set <name> <value>, reset [name] (or /settings in a session)
  mnemo memory …           memory for other agents: ingest Claude Code sessions (mnemo memory --help)
  mnemo schedule …         run a prompt on a timer, read-only unless you allow actions (mnemo schedule --help)
  mnemo --demo             a scripted session in a scratch project (no key needed)
  mnemo --rpc              the session over JSON lines on stdin/stdout, for an editor extension (docs/RPC.md);
                           approvals are the client's to answer, as in the terminal

options
  --cwd <dir>              work in another folder
  --model <provider/id>    use this model for this run (the saved default is untouched; /model changes that)
  --plan                   start in plan mode (read-only)
  --accept-edits           change files in the project without asking (commands still ask)
  --yolo                   ask for nothing (deny rules in permissions.json still hold)
  --trust-project          load this folder's .pi/ extensions, settings and skills without asking (they run code)
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
  /** doctor --fix */
  fix?: boolean;
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
  model?: string;
  continueRecent: boolean;
  trustProject?: boolean;
  print?: string;
  rpc?: boolean;
  cwd?: string;
}

/** A mistake in the command line: exits 2, like the subcommands' usage errors. */
class UsageError extends Error {}

function parse(argv: string[]): Args {
  /** The value after option `v`: there must be one, and it must not be the next option. */
  const value = (i: number, v: string): string => {
    const next = argv[i];
    if (next === undefined || next.trim() === "" || /^--?[A-Za-z]/.test(next))
      throw new UsageError(`${v} needs a value${next === undefined || next.trim() === "" ? "" : `, not the option ${next}`} — mnemo --help lists them`);
    return next;
  };
  const a: Args = { help: false, version: false, demo: false, dump: false, motion: true, boot: true, inline: false, intro: false, memory: true, reflect: true, verify: true, escalate: process.env.MNEMO_ESCALATE_MODEL || undefined, mode: "default", continueRecent: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "doctor" && i === 0) a.command = "doctor";
    else if (v === "--fix" && a.command === "doctor") a.fix = true;
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
    else if (v === "--escalate") a.escalate = value(++i, v);
    else if (v === "--best-of") a.bestOf = Number(value(++i, v));
    else if (v === "--check") a.check = value(++i, v);
    else if (v === "--plan") a.mode = "plan";
    else if (v === "--accept-edits") a.mode = "accept-edits";
    else if (v === "--yolo") a.mode = "yolo";
    else if (v === "--trust-project") a.trustProject = true;
    else if (v === "-c" || v === "--continue") a.continueRecent = true;
    else if (v === "--rpc") a.rpc = true;
    else if (v === "-p" || v === "--print") a.print = value(++i, v);
    else if (v === "--cwd") a.cwd = value(++i, v);
    else if (v === "--model") a.model = value(++i, v);
    else throw new UsageError(`unknown argument ${v} — mnemo --help lists them`);
  }
  return a;
}

/**
 * A folder can carry code of its own (`.pi/extensions/*.ts` runs in this process, before
 * any approval) and instructions (`.pi/SYSTEM.md`, skills). Cloning a repo must not be
 * enough to run it: ask once, remember "always", and without a terminal say what was left out.
 * Returns an override for this run, or undefined to follow what is saved.
 */
async function trustDecision(cwd: string, dir: string, args: Args): Promise<boolean | undefined> {
  if (args.trustProject) return true;
  if (!hasTrustRequiringProjectResources(cwd)) return undefined;
  const store = new ProjectTrustStore(dir);
  if (store.get(cwd) !== null) return undefined;
  const found = [".pi/extensions", ".pi/settings.json", ".pi/mcp.json", ".pi/skills", ".pi/prompts", ".pi/themes", ".agents/skills"].filter((f) => fs.existsSync(path.join(cwd, f)));
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && args.print === undefined && !args.dump;
  if (!interactive) {
    console.error(`mnemo: not loading this folder's ${found.join(", ") || "project resources"} (not trusted; --trust-project allows it)`);
    return undefined;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`This folder ships its own ${found.join(", ")}.\nExtensions run as code with your permissions, before any approval, and the rest steers the model.\nLoad them? [y] this time · [a] always for this folder · [N] no: `)).trim().toLowerCase();
    if (answer === "a") {
      store.set(cwd, true);
      return true;
    }
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** A stdin that never sends a key, for frames rendered without a terminal. */
function silentStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  s.isTTY = true;
  s.setRawMode = () => s;
  return s;
}

async function doctor(home: string, dir: string, fix: boolean): Promise<number> {
  const ok = (b: boolean) => (b ? "✓" : "✗");
  const lines: string[] = [`mnemo ${pkg.version} · bun ${Bun.version} · ${process.platform}-${process.arch}`, `home    ${home}`];
  // The model a run would start on, chosen the way main() chooses it.
  const models = await createModelRuntime(dir);
  const runtime = await startRuntime({ cwd: process.cwd(), agentDir: dir, modelRuntime: models, model: chooseModel(models, { agentDir: dir, continuing: false }).model, sessionManager: SessionManager.inMemory(process.cwd()) });
  const model = runtime.session.model;
  const usable = !!model && runtime.session.modelRuntime.hasConfiguredAuth(model.provider);
  lines.push(`${ok(usable)} model   ${usable ? `${model!.provider}/${model!.id}` : "none — run mnemo, then /login"}`);
  // AWS credentials come from files and roles Mnemo cannot check without calling Bedrock.
  if (usable && model!.provider === "amazon-bedrock") lines.push("  note    Bedrock's AWS credentials are not checked here; mnemo -p hi tries them (--model picks another)");
  for (const h of envHints(process.env)) lines.push(`✗ ${h}`);
  await runtime.dispose();
  const memsrv = findMemsrv(home);
  const memory = memsrv ? await checkMemory(memsrv, journalPath(home), home) : undefined;
  if (memory) lines.push(...memory.lines);
  else {
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
  const managed = loadManaged();
  if (managed?.error) lines.push(`✗ policy  ${managed.file}: ${managed.error} (edits and commands are refused until it is fixed)`);
  else if (managed) lines.push(`  policy  managed by ${managed.file}: ${managed.rules.length} rules${managed.modes ? `, modes ${managed.modes.join("/")}` : ""}${managed.models ? `, models ${managed.models.join(" ")}` : ""}${managed.mcpServers ? `, MCP ${managed.mcpServers.join(" ") || "none"}` : ""}`);
  const problems = findProblems(home);
  for (const p of problems) lines.push(`✗ ${p.problem}`);
  lines.push(...placement(home));
  console.log(lines.join("\n"));
  if (!fix) {
    if (problems.length || (!memsrv && installKind(process.execPath, home) === "installer")) console.log("\nmnemo doctor --fix repairs what it can");
    return usable && memory?.ok && !problems.length ? 0 : 1;
  }
  console.log("");
  for (const p of problems) {
    try {
      console.log(`fixed   ${p.fix()}`);
    } catch (error) {
      console.log(`failed  ${p.problem}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let memsrvNow = memsrv;
  if (!memsrv) {
    if (installKind(process.execPath, home) === "installer") {
      console.log(`reinstalling v${pkg.version} to put ${memsrvName()} back…`);
      const code = await runInstaller(pkg.version, home, (l) => console.log(`  ${l}`));
      memsrvNow = code === 0 ? findMemsrv(home) : undefined;
      console.log(memsrvNow ? `fixed   ${memsrvNow}` : "failed  the installer did not put memsrv back");
    } else console.log(`cannot  ${memsrvName()}: build it (cargo build --release --bin memsrv) or reinstall Mnemo the way you installed it`);
  }
  if (!usable) console.log("cannot  no model: run mnemo, then /login");
  if (memory && !memory.ok) console.log("cannot  memsrv did not answer: its log says why");
  if (!problems.length && memory?.ok && usable) console.log("nothing to fix");
  return usable && memsrvNow && memory?.ok !== false ? 0 : 1;
}

/** Whether a new terminal's `mnemo` is this one (it is not when a download was never installed). */
function placement(home: string): string[] {
  return placementProblems({ execPath: process.execPath, home, platform: process.platform, kind: installKind(process.execPath, home), which: (n) => Bun.which(n) });
}

/** Small per-user state: whether the introduction has been seen. */
interface State {
  onboarded?: boolean;
  /** The opt-in daily update check, when it last ran, and what it found. */
  autoUpdate?: boolean;
  updateCheckedAt?: number;
  updateAvailable?: string;
  /** Folders agents were opened in, most recent first. */
  recent?: string[];
  /** Project folders the user linked, so they are linked again when both are open. */
  links?: [string, string][];
  theme?: ThemeName;
  /** The folder a downloaded copy was told not to install itself from. */
  selfInstallDeclined?: string;
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
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(state, null, 2), { mode: 0o600 });
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
    ...(args.model ? ["--model", args.model] : []),
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

/** `mnemo update [--check] [--auto on|off]` */
async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return String(line).trim();
  return "";
}

async function uninstallCommand(argv: string[], home: string): Promise<number> {
  const unknown = argv.find((a) => a !== "--deep" && a !== "--yes" && a !== "-y");
  if (unknown) return console.error(`mnemo uninstall: unknown option ${unknown} (--deep, --yes)`), 2;
  const deep = argv.includes("--deep");
  const yes = argv.includes("--yes") || argv.includes("-y");
  const kind = installKind(process.execPath, home);
  const plan = planUninstall({ kind, home, deep, linkDir: process.env.MNEMO_LINK_DIR });
  // --deep that cannot delete the data is not a success, whatever else goes.
  let refused = false;
  if (plan.data && !looksLikeMnemoHome(plan.data.dir)) {
    console.error(`mnemo uninstall: ${plan.data.dir} holds files Mnemo did not put there; it is not deleted. Remove what you want from it by hand.`);
    plan.data = undefined;
    refused = true;
  }
  if (kind === "source") console.log("You are running from a source checkout: there is no installed program to remove.");
  const lines = describePlan(plan);
  if (!plan.files.length && !plan.link && !plan.pathEntry && !plan.data) {
    for (const l of lines) console.log(l);
    if (!plan.manager && !refused) console.log("Nothing to remove.");
    return refused ? 1 : 0;
  }
  console.log("mnemo uninstall\n");
  for (const l of lines) console.log(`  ${l}`);
  if (!plan.data) console.log(`\n  kept    ${home} (memory, sessions, settings${refused ? "" : "; --deep deletes them too"})`);
  if (!yes) {
    if (!process.stdin.isTTY) return console.error("\nmnemo uninstall: not a terminal; add --yes to go ahead"), 2;
    const answer = plan.data ? await ask('\nThis cannot be undone. Type "delete" to go ahead: ') : await ask("\nGo ahead? [y/N] ");
    if (plan.data ? answer !== "delete" : !/^y(es)?$/i.test(answer)) return console.log("Nothing changed."), 1;
  }
  console.log("");
  for (const l of runUninstall(plan)) console.log(`  ✓ ${l}`);
  if (refused) {
    console.error(`\nmnemo uninstall: the program is removed, but ${home} was not deleted (it holds files Mnemo did not put there).`);
    if (plan.manager) console.log(`Then run  ${plan.manager}`);
    return 1;
  }
  console.log("\nMnemo is uninstalled. If you attached its memory to Claude Code or Codex (mnemo memory setup), remove the mnemo entries from their settings too.");
  if (plan.manager) console.log(`Then run  ${plan.manager}`);
  return 0;
}

/** `mnemo install [--yes]`: this copy, with the memsrv beside it, into $MNEMO_HOME/bin. */
async function installCommand(argv: string[], home: string): Promise<number> {
  const unknown = argv.find((a) => a !== "--yes" && a !== "-y");
  if (unknown) return console.error(`mnemo install: unknown option ${unknown} (--yes)`), 2;
  const kind = installKind(process.execPath, home);
  if (kind === "installer") return console.log(`Mnemo is installed in ${path.dirname(process.execPath)}`), 0;
  if (kind === "source") return console.error("mnemo install: this is a source checkout; build a binary first (bun run build)"), 1;
  if (kind !== "elsewhere") return console.error(`mnemo install: this copy is managed by ${kind}; ${manualStep(kind, pkg.version)} keeps it up to date`), 1;
  if (!argv.length) {
    if (!process.stdin.isTTY) return console.error("mnemo install: not a terminal; add --yes to go ahead"), 2;
    if (!/^(y(es)?)?$/i.test(await ask(`Install Mnemo to ${path.join(home, "bin")} and add it to your PATH? [Y/n] `))) return console.log("Nothing changed."), 1;
  }
  return installHere(home);
}

function installHere(home: string): number {
  try {
    const { done, next } = selfInstall({ execPath: process.execPath, home, platform: process.platform, env: process.env });
    for (const l of done) console.log(`  ✓ ${l}`);
    console.log(`\nMnemo is installed. ${next.join("\n")}`);
    return 0;
  } catch (error) {
    console.error(`mnemo install: ${message(error)}`);
    return 1;
  }
}

/**
 * A copy started from where it was unzipped offers, once, to install itself. Yes ends
 * with what to do next instead of starting Mnemo: this window was opened in the download
 * folder, which is no project to work in, and only a new terminal sees the new PATH.
 * Returns an exit code when Mnemo should stop here.
 */
async function offerInstall(home: string): Promise<number | undefined> {
  const offer = selfInstallOffer({ platform: process.platform, execPath: process.execPath, home, version: pkg.version, env: process.env, declined: readState(home).selfInstallDeclined });
  if (!offer) return undefined;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!/^(y(es)?)?$/i.test((await rl.question(`${offer.question} [Y/n] `)).trim())) {
      writeState(home, { ...readState(home), selfInstallDeclined: offer.from });
      console.log(`Running from ${offer.from}. mnemo install installs it later.\n`);
      return undefined;
    }
    const code = installHere(home);
    if (await ownConsole()) await rl.question("\nPress Enter to close.");
    return code;
  } finally {
    rl.close();
  }
}

async function updateCommand(argv: string[], home: string): Promise<number> {
  const auto = argv[0] === "--auto" ? argv[1] : undefined;
  if (argv[0] === "--auto") {
    if (auto !== "on" && auto !== "off") return console.error("mnemo update --auto on|off"), 2;
    writeState(home, { ...readState(home), autoUpdate: auto === "on" });
    console.log(
      auto === "on"
        ? "update check on: once a day, at launch, Mnemo asks GitHub for the latest version and tells you about a newer one. Nothing installs without you."
        : "update check off: Mnemo makes no request of its own.",
    );
    return 0;
  }
  if (argv.length > 1 || (argv[0] && argv[0] !== "--check")) return console.error("usage: mnemo update [--check] [--auto on|off]"), 2;
  const latest = await latestVersion();
  if (!latest) return console.error("mnemo update: could not reach GitHub"), 1;
  writeState(home, { ...readState(home), updateCheckedAt: Date.now(), updateAvailable: latest });
  if (compareVersions(latest, pkg.version) <= 0) return console.log(`mnemo v${pkg.version} is the latest`), 0;
  console.log(`mnemo v${latest} is available (you have v${pkg.version})`);
  if (argv[0] === "--check") return 0;
  const kind = installKind(process.execPath, home);
  if (kind !== "installer") return console.log(`this copy is managed elsewhere; update it with:\n  ${manualStep(kind, latest)}`), 0;
  const code = await runInstaller(latest, home, (line) => console.log(line));
  if (code === 0) console.log(`updated to v${latest}`);
  return code;
}

/** `mnemo settings`: the same list and changes as /settings, for a script or a machine with no terminal. */
function settingsCli(argv: string[], home: string): number {
  const r = settingsCommand(openSettings(home), argv);
  (r.ok ? console.log : console.error)(r.text);
  return r.ok ? 0 : 1;
}

async function main(): Promise<number> {
  if (process.argv[2] === "settings") return settingsCli(process.argv.slice(3), mnemoHome());
  if (process.argv[2] === "update") return updateCommand(process.argv.slice(3), mnemoHome());
  if (process.argv[2] === "install") return installCommand(process.argv.slice(3), mnemoHome());
  if (process.argv[2] === "uninstall") return uninstallCommand(process.argv.slice(3), mnemoHome());
  if (process.argv[2] === "schedule") return scheduleCommand(process.argv.slice(3), mnemoHome());
  if (process.argv[2] === "memory") {
    const home = mnemoHome();
    pointPiAt(agentDir(home));
    return runMemoryCommand(process.argv.slice(3), home, agentDir(home));
  }
  const args = parse(process.argv.slice(2));
  if (args.help) return console.log(USAGE), 0;
  if (args.version) return console.log(pkg.version), 0;
  if (mayOffer(process.argv.slice(2), process.stdin.isTTY === true && process.stdout.isTTY === true, process.env)) {
    const code = await offerInstall(mnemoHome());
    if (code !== undefined) return code;
  }

  const home = mnemoHome();
  const dir = agentDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  pointPiAt(dir);
  if (args.command === "doctor") return doctor(home, dir, args.fix === true);
  if (args.bestOf !== undefined) return runBestOf(args, home);

  // What the user tuned. A flag or an environment variable names this run only and wins; the settings can switch things
  // off that are on by default, never turn on what a flag turned off.
  const settings = openSettings(home);
  const cfg = settings.get();
  args.motion &&= cfg.motion;
  args.boot &&= cfg.bootAnimation;

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
  if (!args.demo) {
    const choice = chooseModel(modelRuntime, { flag: args.model, agentDir: dir, continuing: args.continueRecent });
    if (choice.error) return console.error(`mnemo: ${choice.error}`), 2;
    if (choice.model) injected = { ...injected, model: choice.model };
  }
  // Not in the demo, whose script expects the mode it was written for. Bypass modes are never a default (see settings.ts).
  if (args.mode === "default" && !args.demo) args.mode = cfg.mode;
  // An administrator's managed policy can rule a mode out (`--yolo`, say); say so rather than pretend.
  const ceiling = allowedMode(args.mode, loadManaged());
  if (ceiling !== args.mode) {
    console.error(`mnemo: the managed policy (${managedPath()}) does not allow ${args.mode} mode; starting in ${ceiling}.`);
    args.mode = ceiling;
  }

  const memsrv = args.memory ? findMemsrv(home) : undefined;
  const memory = memsrv ? new MemoryService(memsrv, journal) : undefined;
  const runtimeModels = modelRuntime;
  const firstTrust = args.demo ? undefined : await trustDecision(cwd, dir, args);
  /** Every agent of the process, as a tree: sub-agents, sibling links and who may message whom. */
  const roster = new Roster();
  /** One agent's host and pi session in `agentCwd`; the first gets --continue and the demo's injections. */
  const makeAgent = async (agentCwd: string, first = false) => {
    const host = createHost({ roster, home, agentDir: dir, modelRuntime: runtimeModels, memory, mode: args.mode, settings, reflect: args.reflect, verify: args.verify, escalate: args.escalate });
    try {
      const runtime = await startRuntime({
        cwd: agentCwd,
        agentDir: dir,
        modelRuntime: runtimeModels,
        continueRecent: first && args.continueRecent,
        trustProject: first ? firstTrust : undefined,
        extensions: mnemoExtensions(host),
        ...(first ? injected : {}),
      });
      return { host, runtime };
    } catch (e) {
      // The host put the agent in the roster; one that never started must not stay listed.
      roster.removeRoot(host.node);
      throw e;
    }
  };
  const { host, runtime } = await makeAgent(cwd, true);

  if (args.rpc) {
    // stdout is the protocol: anything else that prints goes to stderr.
    console.log = console.info = console.warn = console.debug = (...a: unknown[]) => console.error(...a);
    let finish!: () => void;
    const closed = new Promise<void>((r) => (finish = r));
    const controller = new Controller(runtime, { exit: () => finish(), host });
    await controller.bind();
    const server = new RpcServer({ controller, version: pkg.version, write: (e) => void process.stdout.write(`${JSON.stringify(e)}\n`), onQuit: () => finish() });
    server.start();
    if (args.continueRecent && runtime.session.messages.length > 0) controller.transcript.load(runtime.session.messages);
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (l) => void server.handle(l));
    rl.on("close", () => finish());
    await closed;
    server.stop();
    controller.dialogs.cancelAll();
    await runtime.dispose();
    memory?.stop();
    return 0;
  }

  if (args.print !== undefined) {
    const session = runtime.session;
    await session.bindExtensions({});
    try {
      if (!session.model || !session.modelRuntime.hasConfiguredAuth(session.model.provider)) {
        console.error("mnemo: no model configured — run mnemo and use /login, then /model");
        return 1;
      }
      await session.prompt(args.print);
      const st = session.getSessionStats();
      const spent = host.roster.get(host.node)?.runSpend ?? st.cost;
      // What the run took, on stderr so the answer on stdout stays clean for a script.
      console.error(`mnemo: ${st.assistantMessages} model calls, ${st.toolCalls} tool calls, ${st.tokens.input.toLocaleString()} in / ${st.tokens.output.toLocaleString()} out tokens, $${spent.toFixed(4)}`);
      const budget = host.roster.limits.runSpend;
      if (budget > 0 && spent >= budget) {
        console.error(`mnemo: stopped at the run budget ($${budget.toFixed(2)}; mnemo settings runSpend <dollars> changes it)`);
        return 1;
      }
      // A refused or failed model call (a bad key, an outage) ends the turn quietly: say so, and fail.
      const last = session.messages.findLast((m) => m.role === "assistant");
      if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
        console.error(`mnemo: the model call failed: ${last.errorMessage || last.stopReason}`);
        return 1;
      }
      process.stdout.write(`${session.getLastAssistantText() ?? ""}\n`);
      await settleBackground(host);
      return 0;
    } finally {
      await runtime.dispose();
      memory?.stop();
    }
  }

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !args.dump;
  setLinks(interactive && process.env.MNEMO_LINKS !== "0");
  let instance: ReturnType<typeof render> | undefined;
  const clearTerminal = () => {
    instance?.clear();
    // The workspace is on the alternate screen, which Ink's clear covers; \x1b[3J there would
    // erase the scrollback the user had before starting Mnemo. Inline, the transcript is the scrollback.
    if (layout === "inline" && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  };
  let exitCode = 0;
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));
  const state = readState(home);
  applyTheme(cfg.theme);
  const updater: Updater = {
    current: pkg.version,
    kind: installKind(process.execPath, home),
    latest: async () => {
      const v = await latestVersion();
      if (v) writeState(home, { ...readState(home), updateCheckedAt: Date.now(), updateAvailable: v });
      return v;
    },
    install: (version, log) => runInstaller(version, home, log),
    setAuto: (on) => writeState(home, { ...readState(home), autoUpdate: on }),
  };
  // Long turns and approvals tell a terminal in the background (see ui/notify.ts).
  const notifier = interactive && cfg.notify && process.env.MNEMO_NOTIFY !== "0" ? new Notifier((t) => process.stdout.write(t), Date.now, () => settings.get().notifyAfter * 1000) : undefined;
  const watch = (dir: string, c: Controller) => notifier?.watch(path.basename(dir) || dir, c);
  // Every agent of this process. The program ends when the last one closes.
  const fleet = new Fleet(
    async (agentCwd, exit) => {
      const made = await makeAgent(agentCwd);
      const c = new Controller(made.runtime, { exit, onClearScreen: clearTerminal, host: made.host, updater });
      await c.bind();
      c.transcript.push({ kind: "welcome" });
      watch(agentCwd, c);
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
      links: state.links,
      saveLinks: (links) => writeState(home, { ...readState(home), links }),
    },
  );
  let firstId = 0;
  const controller = new Controller(runtime, { exit: (code) => fleet.closed(firstId, code ?? 0), onClearScreen: clearTerminal, host, updater });
  await controller.bind();
  controller.transcript.push({ kind: "welcome" });
  watch(cwd, controller);
  firstId = fleet.adopt(cwd, { controller, host, source: workspaceSource(controller, host, home) }).id;
  // From here a failure nothing caught (an extension's timer, a stray promise) is a notice in
  // every open agent, not the end of the session.
  onStrayError = (kind, error) => {
    const file = logError(home, kind, error);
    for (const a of fleet.snapshot().agents) a.controller.transcript.notice(`Something failed in the background: ${message(error)} (details in ${file})`, "warn");
  };
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
      // Ink otherwise treats even a real terminal as non-interactive under CI.
      // Use the same TTY decision for rendering and for waiting on user input.
      interactive,
      ...(interactive ? {} : { stdin: silentStdin() }),
    },
  );

  // A resize redraws the whole screen. Ink clears on its own only when the width
  // shrinks; on the full-screen workspace a shorter or wider window would keep
  // rows of the old frame. This runs before Ink's own handler, which then draws
  // the new frame on a clean screen.
  if (interactive && layout === "workspace")
    process.stdout.prependListener("resize", () => {
      process.stdout.write("\x1b[2J\x1b[H");
      instance.clear();
    });

  // The full-screen workspace has no scrollback, so the wheel is ours: ask the terminal to report it.
  // Handed back on every way out; MNEMO_MOUSE=0 never takes it (text selection stays the terminal's).
  if (interactive && layout === "workspace" && process.env.MNEMO_MOUSE !== "0" && cfg.mouse) {
    mouse.set(true);
    process.on("exit", () => mouse.set(false));
  }

  if (notifier) {
    process.stdout.write(FOCUS_ON);
    process.stdin.on("data", (chunk) => notifier.input(String(chunk)));
    process.on("exit", () => process.stdout.write(FOCUS_OFF));
  }

  if (interactive && !args.demo) {
    clearReplaced(home);
    // What an earlier check found, without asking again; then, if turned on and due, ask.
    const announce = (v: string | undefined) => {
      if (v && compareVersions(v, pkg.version) > 0) controller.transcript.notice(`Mnemo v${v} is available (you have v${pkg.version}). /update installs it.`);
    };
    const st = readState(home);
    if (shouldCheck({ auto: st.autoUpdate, checkedAt: st.updateCheckedAt, now: Date.now(), env: process.env })) void updater.latest().then(announce);
    else announce(st.updateAvailable);
  }

  if (args.demo && !args.dump) setTimeout(() => void controller.submit(DEMO_PROMPT), 900);
  if (args.dump) {
    if (args.demo) {
      // Awaited, not scheduled: a slow runner must not dump a frame before the turn began.
      await controller.submit(DEMO_PROMPT);
      await runtime.session.waitForIdle();
      await settleBackground(host);
      await new Promise((r) => setTimeout(r, 50));
    }
    await instance.waitUntilRenderFlush();
    await controller.quit();
  }

  await done;
  mouse.set(false);
  memory?.stop();
  instance.unmount();
  // A painted theme changed the terminal's default colours: give them back.
  if (interactive && themePaints()) process.stdout.write("\x1b]110\x07\x1b]111\x07");
  if (interactive && layout === "workspace") process.stdout.write(`${exitLine(fleet.snapshot().summary)}\n`);
  await instance.waitUntilExit().catch(() => {});
  return exitCode;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failure nothing caught, appended to $MNEMO_HOME/logs/errors.log. Returns the file. */
function logError(home: string, kind: string, error: unknown): string {
  const dir = path.join(home, "logs");
  const file = path.join(dir, "errors.log");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${new Date().toISOString()} ${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`, { mode: 0o600 });
  } catch {
    /* nowhere to write: the message is still shown */
  }
  return file;
}

/** Set once the interface is up. Before that, a stray failure is fatal, as it always was. */
let onStrayError: ((kind: string, error: unknown) => void) | undefined;
function strayError(kind: string, error: unknown): void {
  if (onStrayError) {
    try {
      return onStrayError(kind, error);
    } catch {
      /* the interface itself is broken: fall through to exiting */
    }
  }
  logError(mnemoHome(), kind, error);
  console.error(`mnemo: ${message(error)}`);
  process.exit(1);
}
process.on("unhandledRejection", (error) => strayError("unhandled rejection", error));
process.on("uncaughtException", (error) => strayError("uncaught exception", error));

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`mnemo: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  },
);
