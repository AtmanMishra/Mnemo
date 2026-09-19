#!/usr/bin/env bun
/**
 * mnemo — the application entry.
 *
 * This is the program. The division of labour it establishes is the point of the
 * rebuild:
 *
 *   app/ (here)          the application: the interface, sessions, tools, policy
 *   memory-layer/ (Rust) memory: the journal, recall, consolidation — via RPC
 *   kernel/ipy_bridge.py execution: one long-lived interpreter, driven per cell
 *
 * Commands that need no model and no key come first, because they are the ones
 * that must work when everything else is broken:
 *
 *   mnemo --dump [--rows N --cols N]   render one frame and exit
 *   mnemo doctor                       can this installation work?
 *   mnemo --version | --help
 */
import { collectFacts } from "../src/facts.ts";
import { renderFrame, banner, setupSteps, statusLines } from "../src/frame/frame.ts";
import { renderStatusLine } from "../src/status/status.ts";
import { splash } from "../src/brand/brand.ts";
import { startTui } from "../src/input/pty.ts";
import { Session } from "../src/session/session.ts";

export const VERSION = "0.1.0";

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(name);
const valueOf = (name: string, fallback: number): number => {
  const i = argv.indexOf(name);
  const raw = i >= 0 ? Number(argv[i + 1]) : Number.NaN;
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

const USAGE = [
  "mnemo — a terminal coding agent whose memory persists",
  "",
  "  mnemo                              the interface",
  "  mnemo --dump [--rows N --cols N]   render one frame and exit",
  "  mnemo doctor                       check that this installation can work",
  "  mnemo --version | --help",
  "",
  "Runs on Bun. Providers are configured with /login inside the interface, an",
  "environment key, or a subscription the agent already holds.",
].join("\n");

function dump(): void {
  const facts = collectFacts();
  console.log(
    renderFrame({
      ...facts,
      rows: valueOf("--rows", 24),
      cols: valueOf("--cols", 100),
    }),
  );
}

/**
 * The health check. Exit 1 when something *required* is missing; a feature that
 * is off is a warning, because "this cannot work" and "this is partially
 * configured" are different sentences and an exit code that conflates them
 * sends people after the wrong thing.
 */
function doctor(): number {
  const facts = collectFacts();
  const lines: Array<{ ok: boolean; required: boolean; name: string; detail: string; fix?: string }> = [
    { ok: true, required: true, name: "runtime", detail: facts.runtime },
    {
      ok: Boolean(facts.provider),
      required: true,
      name: "provider",
      detail: facts.provider ?? "none configured",
      fix: "run mnemo and type /login (or /login <provider> <key> if you know the name)",
    },
    {
      ok: Boolean(facts.model),
      required: false,
      name: "default model",
      detail: facts.model ?? "none chosen",
      fix: "run /model in Mnemo to pick one from what your key can run",
    },
    {
      ok: facts.memory,
      required: false,
      name: "memory sidecar",
      detail: facts.memory ? "found" : "not found",
      fix: "build it (cd memory-layer && cargo build --bin memsrv) or point MNEMO_MEMSRV_BIN at one",
    },
    {
      ok: facts.kernel,
      required: false,
      name: "ipy kernel",
      detail: facts.kernel ? "interpreter found" : "no interpreter found",
      fix: "install Python 3, or set SEA_PYTHON to an interpreter",
    },
    { ok: true, required: false, name: "home", detail: facts.home },
  ];

  console.log("mnemo doctor — can this installation work?");
  for (const line of lines) {
    const mark = line.ok ? "ok  " : line.required ? "FAIL" : "warn";
    console.log(`  ${mark}  ${line.name.padEnd(16)} ${line.detail}`);
    if (!line.ok && line.fix) console.log(`        fix: ${line.fix}`);
  }
  const failed = lines.filter((l) => l.required && !l.ok).length;
  console.log(
    failed > 0
      ? "Something required is missing — the fix is printed under each line."
      : "Mnemo can run." + (lines.some((l) => !l.ok) ? " Some optional pieces are off." : ""),
  );
  return failed > 0 ? 1 : 0;
}

function run(): number | "interactive" {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  if (!bun) {
    console.error(
      [
        "mnemo is a Bun program, and this is not Bun.",
        "",
        "  bun upgrade            # or: curl -fsSL https://bun.sh/install | bash",
      ].join("\n"),
    );
    return 1;
  }
  if (has("--version") || has("-v")) {
    console.log(`mnemo ${VERSION} — bun ${bun.version}`);
    return 0;
  }
  if (has("--help") || has("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (has("--dump")) {
    dump();
    return 0;
  }
  if (argv[0] === "doctor") return doctor();

  if (argv.length === 0 || argv[0] === "chat" || argv[0] === "run") {
    interactive();
    return "interactive";
  }

  console.error(USAGE);
  return 2;
}

/**
 * The interface itself.
 *
 * No agent yet: one is built from the configured provider, and until that is
 * wired the interface still runs, still takes input, and says what to do about
 * it. A program that refuses to start because it is not configured is a program
 * you cannot configure from inside it.
 */
function interactive(): void {
  // `keepLive: 0`: the opening is the top of the transcript, so it settles into
  // scrollback immediately and stays there. With the default the opening was
  // still "live" when the reader left, and pressing ctrl+d erased the banner and
  // the instructions with `\x1b[10A` — the interface deleting its own welcome on
  // the way out.
  const session = new Session({ keepLive: 0 });
  // The same opening `--dump` renders, shown here too. It existed in one code
  // path and was missing from the one people actually run: a clean home got a
  // bare `> ` cursor with no word about what to do, which is the exact failure
  // the old interface was retired over.
  const facts = collectFacts();
  const cols = process.stdout.columns ?? 80;
  session.apply({
    type: "opening",
    lines: [
      banner(cols, facts.runtime),
      "",
      // The figure below the banner, dropped entirely when the terminal is too
      // narrow to show it whole — a half-drawn crab is worse than none.
      ...splash(cols),
      ...(facts.provider ? statusLines(cols, facts) : setupSteps(cols)),
    ],
  });
  startTui({
    streams: {
      stdin: process.stdin,
      stdout: process.stdout,
    },
    session,
    facts: { home: facts.home, provider: facts.provider, model: facts.model },
    // Re-collected every frame, so `/login` and `/model` are visible in the
    // chrome the moment they take effect rather than after a restart.
    status: () => renderStatusLine(collectFacts(), { width: process.stdout.columns ?? 80, preset: "default" }),
    exit: (code) => process.exit(code ?? 0),
  });
}

if (import.meta.main) {
  const result = run();
  // "interactive" means the interface owns the process from here; setting an
  // exit code would end it immediately after drawing the first frame.
  if (result !== "interactive") process.exitCode = result;
}
