#!/usr/bin/env bun
/**
 * mnemo — the application entry.
 *
 * This file is the program. It is a Bun program on purpose, and the division of
 * labour it establishes is the point of the rewrite:
 *
 *   this file                    the application: what runs, in what order
 *   @earendil-works/pi-coding-*  the interface and the agent loop (driven, not forked)
 *   memory-layer/ (Rust)         memory: the sidecar owns the journal, we speak RPC
 *   kernel/ipy_bridge.py + ipy   the execution sandbox: one long-lived interpreter
 *   extensions/*                 our tools, approvals, hooks, schedules, tracing
 *
 * The Node entry (`bin/mnemo.ts`) still exists and still works — it is the
 * shim this file imports its session logic from — but it is no longer the
 * program: the two commands a person actually meets (`--dump`, `doctor`) and
 * the runtime guarantee live here, and this is the one that gets installed.
 *
 * Why the split matters, in one line: the old entry could only ever be as good
 * as the runtime it borrowed, and the runtime it borrowed has to be told about
 * TypeScript, about the kernel, about the sidecar, and about the shell. Bun
 * needs telling nothing.
 *
 * Usage:
 *   mnemo                      the interface (pi's interactive mode, our tools)
 *   mnemo --dump [--rows N --cols N]   render one frame and exit; no model, no key
 *   mnemo doctor               is this installation able to work? exit 1 when not
 *   mnemo --version | --help
 *   mnemo auth status|logout <provider>
 *   mnemo traces [session]     span trees from the journal's log
 *   mnemo consolidate          distil episodes into semantic lessons
 *   mnemo init | pr | schedule …   forwarded to the implementations we already have
 */
import { main } from "@earendil-works/pi-coding-agent";
import { checkBunVersion, MIN_BUN } from "../src/runtime_check.ts";
import { doctorExitCode, doctorLines, probesOf } from "../src/app/doctor.ts";
import { renderBootFrame } from "../src/app/frame.ts";
import { mnemoHome } from "../src/home.ts";
import { pickProvider, missingKeyMessage } from "../src/provider.ts";
import { credentials } from "../src/auth/pi_store.ts";
import { PROVIDERS, loadAuth } from "../src/auth/store.ts";
import { setAgentProcessMarkers } from "../src/childenv.ts";
import { runConsolidate, sharedMem } from "../extensions/memory-layer.ts";
import { runInit } from "../src/init.ts";
import { runPr } from "../src/pr.ts";
import { runSchedule } from "../src/schedule/cli.ts";
import {
  ensureAuthenticated, factories, handleAuth, handleListSessions, loadMcpTools,
  printSkillsBanner, renderTraces,
} from "./mnemo.ts";

const argv = process.argv.slice(2);
const flagValue = (name: string, fallback: number): number => {
  const i = argv.indexOf(name);
  const raw = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

function versionLine(): string {
  const runtime = (globalThis as { Bun?: { version: string } }).Bun?.version;
  return `mnemo dev (pre-alpha) — ${runtime ? `bun ${runtime}` : `node ${process.version}`}`;
}

function usage(): string {
  return [
    "mnemo — a terminal coding agent whose memory persists",
    "",
    "  mnemo                              the interface",
    "  mnemo --dump [--rows N --cols N]   render one frame and exit",
    "  mnemo doctor                       check that this installation can work",
    "  mnemo auth status|logout <p>       what is configured, or remove it",
    "  mnemo traces [session]             span trees from the log",
    "  mnemo consolidate                  distil episodes into lessons",
    "  mnemo init | pr | schedule …       project memory, PRs, scheduled runs",
    "  mnemo --version | --help",
    "",
    `Runs on Bun >= ${MIN_BUN.major}.${MIN_BUN.minor}. Providers: /login inside the interface,`,
    "or an environment key, or a subscription pi already holds.",
  ].join("\n");
}

/** The providers this installation can actually run a model with: ours, plus pi's. */
function configuredProviders(): string[] {
  const auth = loadAuth() as {
    providers?: Record<string, { key?: string; accessToken?: string }>;
  };
  const ours = PROVIDERS.filter((p) => {
    const entry = auth.providers?.[p];
    return Boolean(entry?.key || entry?.accessToken);
  });
  return [...new Set<string>([...ours, ...credentials(process.env)])];
}

/** The default model, from our store, tolerating the shapes it has had. */
function configuredModel(): string {
  const auth = loadAuth() as {
    defaultModel?: string;
    defaultProvider?: string;
    providers?: Record<string, { defaultModel?: string }>;
  };
  if (auth.defaultModel) return auth.defaultModel;
  if (auth.defaultProvider) return auth.providers?.[auth.defaultProvider]?.defaultModel ?? "";
  return "";
}

/** One frame, no model, no key, no spawn — the check anybody can re-run. */
function dumpFrame(): void {
  const probes = probesOf({ providers: configuredProviders, model: configuredModel });
  const lines = doctorLines(probes);
  const providers = configuredProviders();
  console.log(
    renderBootFrame({
      rows: flagValue("--rows", 24),
      cols: flagValue("--cols", 100),
      runtime: probes.runtime,
      home: probes.home,
      provider: providers[0],
      model: configuredModel(),
      memsrv: lines.find((l) => l.name === "memory sidecar")?.ok ?? false,
      kernel: lines.find((l) => l.name === "ipy kernel")?.ok ?? false,
    }),
  );
}

function runDoctor(): number {
  const lines = doctorLines(probesOf({ providers: configuredProviders, model: configuredModel }));
  console.log("mnemo doctor — can this installation work?");
  for (const l of lines) console.log(l.text);
  const exit = doctorExitCode(lines);
  console.log(
    exit === 0
      ? "Mnemo can run." + (lines.some((l) => !l.ok) ? " Some optional pieces are off." : "")
      : "Something required is missing — the fix is printed above each line.",
  );
  return exit;
}

/** The interface: pi's interactive mode, our tools, our memory, our gates. */
async function runInterface(args: string[]): Promise<number> {
  // Set before anything can spawn a child, exactly as pi's own CLI does: a
  // subprocess needs to be able to say which agent started it.
  setAgentProcessMarkers();

  const selection = pickProvider();
  if (!(await ensureAuthenticated())) {
    console.error(missingKeyMessage(selection));
    console.error("or run `mnemo` and log in from inside the interface (/login)");
    return 1;
  }

  const forwarded = [...args];
  const has = (name: string) => forwarded.some((a) => a === name || a.startsWith(`${name}=`));
  if (selection && !has("--provider")) forwarded.push("--provider", selection.provider);
  const model = selection?.modelId ?? "";
  if (model && !has("--model")) forwarded.push("--model", model);
  // Our tools are the surface: pi's built-ins would be a second, ungated set.
  if (!forwarded.includes("--no-builtin-tools")) forwarded.push("--no-builtin-tools");

  await loadMcpTools();
  await printSkillsBanner();
  await main(forwarded, { extensionFactories: factories() });
  return 0;
}

async function run(): Promise<number> {
  // The runtime gate comes first: on an old Bun the next import is what fails,
  // and a stack trace about a syntax error explains nothing to the person who
  // just installed this.
  const bunProblem = checkBunVersion();
  if (bunProblem) {
    console.error(bunProblem);
    return 1;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(versionLine());
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  if (argv.includes("--dump")) {
    dumpFrame();
    return 0;
  }
  if (argv[0] === "doctor") return runDoctor();

  // Everything below needs no provider and no model, and is shared with the
  // Node entry rather than reimplemented: one copy of the session logic.
  if (argv.includes("--list-sessions")) {
    await handleListSessions();
    return 0;
  }
  if (argv[0] === "auth") {
    if ((argv[1] ?? "login") === "login") {
      console.error("mnemo: run `mnemo` and log in there (/login inside the interface).");
      return 1;
    }
    await handleAuth(argv);
    return 0;
  }
  if (argv[0] === "traces") {
    renderTraces(argv);
    return 0;
  }
  if (argv[0] === "consolidate") {
    try {
      await runConsolidate(sharedMem);
    } finally {
      sharedMem.stop();
    }
    return 0;
  }
  if (argv[0] === "init") {
    return runInit(argv.slice(1), {
      cwd: process.cwd(),
      home: mnemoHome(process.env),
      env: process.env,
      log: (s) => console.log(s),
      err: (s) => console.error(s),
    });
  }
  if (argv[0] === "pr") {
    return runPr(argv.slice(1), {
      cwd: process.cwd(),
      home: mnemoHome(process.env),
      env: process.env,
      log: (s) => console.log(s),
      err: (s) => console.error(s),
    });
  }
  if (argv[0] === "schedule") {
    return runSchedule(argv.slice(1), {
      home: mnemoHome(process.env),
      cwd: process.cwd(),
      env: process.env,
      argv: argv.slice(1),
      log: (s) => console.log(s),
      err: (s) => console.error(s),
    });
  }

  return runInterface(argv);
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
