#!/usr/bin/env node
// mnemo CLI entry: thin shim over pi's main().
//
// Usage:
//   mnemo "<prompt>"          one-shot prompt (pi print mode when non-TTY)
//   mnemo                     interactive TUI (pi interactive mode)
//   mnemo consolidate         distil recurring episodes into semantic lessons
//   mnemo traces [session]    print span trees from ~/.mnemo/logs (--json)
//
// MCP servers listed in ~/.mnemo/mcp.json are connected before pi starts and
// their tools registered as mcp__<server>__<tool>.
//   mnemo --list-sessions     list saved sessions from ~/.sea/sessions and exit
//   mnemo --help              pi's own help
//
// Everything else is forwarded to @earendil-works/pi-coding-agent's main():
// provider/model come from pickProvider() unless the user passed explicit
// flags, and --no-builtin-tools keeps only OUR tools active.
// Our extensions run identically in every mode via extensionFactories:
//   sea-tools-inline (all 14 tools), memory-layer (memory tools + lifecycle
//   hooks + persistent-memory directive), approval-gate (y/n gate on
//   bash_exec/write_file/apply_edit in interactive+TTY), hooks (user scoped
//   pre/post-tool + lifecycle hooks: /hook list|test|add|disable).
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { main } from "@earendil-works/pi-coding-agent";
import { discoverSkills } from "../src/skills/discovery.ts";
import { listSessions, defaultSessionDir } from "../src/skills/store.ts";
import { pickProvider, missingKeyMessage } from "../src/provider.ts";
import * as readline from "node:readline/promises";
import {
  PROVIDERS, loadAuth, resolveApiKey, clearProviderAuth,
  setProviderAuth, setDefaultProvider, type ProviderId,
} from "../src/auth/store.ts";
import { runWizard } from "../src/auth/wizard.ts";
import { seaToolsInline } from "../extensions/sea-tools-inline.ts";
import { memoryLayerHooks, runConsolidate, sharedMem } from "../extensions/memory-layer.ts";
import { discoverMcpTools, loadMcpConfig, setMcpTools } from "../src/mcp.ts";
import { formatTree, readSpans, sessionsOf } from "../src/trace.ts";
import { runSchedule } from "../src/schedule/cli.ts";
import { checkNodeVersion } from "../src/runtime_check.ts";
import approvalExt from "../extensions/approval-gate.ts";
import tracingExt from "../extensions/tracing.ts";
import hooksExt from "../extensions/hooks-inline.ts";
import schedulesExt from "../extensions/schedules-inline.ts";

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();

async function handleListSessions(): Promise<void> {
  const sessions = await listSessions(defaultSessionDir());
  if (sessions.length === 0) {
    console.log("(no saved sessions)");
    return;
  }
  const width = Math.max(...sessions.map((s) => s.name.length));
  for (const s of sessions) {
    console.log(
      `${s.name.padEnd(width)}  ${String(s.messageCount).padStart(3)} msgs  ${s.mtime.toISOString()}  ${s.file}`,
    );
  }
}

function realIO() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    write: (s: string) => process.stdout.write(s),
    question: async (q: string) => {
      const a = await rl.question(q);
      return a;
    },
    close: () => rl.close(),
  };
}

/** mnemo auth [status|logout <provider>] — login lives in mnemo-agent (8.8) */
async function handleAuth(args: string[]): Promise<void> {
  const sub = args[1] ?? "login";
  if (sub === "logout") {
    const p = args[2] as ProviderId | undefined;
    if (!p || !(PROVIDERS as readonly string[]).includes(p)) {
      console.error(`usage: mnemo auth logout <${PROVIDERS.join("|")}>`);
      process.exit(1);
    }
    console.log(clearProviderAuth(p) ? `cleared ${p}` : `${p}: nothing stored`);
    return;
  }
  if (sub === "status") {
    const auth = loadAuth();
    for (const p of PROVIDERS) {
      const stored = auth.providers[p];
      const inEnv = Boolean(process.env[
        p === "anthropic" ? "ANTHROPIC_API_KEY" :
        p === "openai" ? "OPENAI_API_KEY" :
        p === "openrouter" ? "OPENROUTER_API_KEY" : "OPENCODE_API_KEY"]);
      const state = inEnv ? "env key" : stored?.key || stored?.accessToken ? "stored" : "-";
      const def = auth.defaultProvider === p ? "  <- default" : "";
      console.log(`${p.padEnd(14)} ${state.padEnd(9)} ${def}`);
    }
    return;
  }
  // login = full wizard
  const io = realIO();
  try {
    const res = await runWizard(io, process.env.HOME ?? "");
    void res;
  } finally {
    io.close();
  }
}

/** Returns provider/model resolved from env or store; runs wizard on first run. */
async function ensureAuthenticated(): Promise<void> {
  // explicit provider via env/flags?
  let selection = pickProvider();
  if (selection && process.env[selection.apiKeyEnv]) return;

  // stored default?
  const auth = loadAuth();
  const storedDefault = auth.defaultProvider;
  const candidates: ProviderId[] = storedDefault
    ? [storedDefault, ...(PROVIDERS as readonly ProviderId[]).filter((p) => p !== storedDefault)]
    : [...(PROVIDERS as readonly ProviderId[])];
  for (const p of candidates) {
    const r = resolveApiKey(p);
    if (r?.key) {
      const envName =
        p === "anthropic" ? "ANTHROPIC_API_KEY" :
        p === "openai" ? "OPENAI_API_KEY" :
        p === "openrouter" ? "OPENROUTER_API_KEY" : "OPENCODE_API_KEY";
      process.env[envName] = r.key;
      if (!process.env.SEA_PROVIDER && !process.env.MNEMO_PROVIDER) {
        process.env.MNEMO_PROVIDER = p;
      }
      if (!process.env.MNEMO_MODEL && !process.env.SEA_MODEL) {
        const model = auth.providers[p]?.defaultModel;
        if (model) process.env.MNEMO_MODEL = model;
      }
      return;
    }
  }

  // nothing anywhere -> first-run wizard (interactive only)
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(missingKeyMessage(selection));
    console.error("or run: mnemo-agent   (log in from inside the app)");
    process.exit(1);
  }
  console.error("No provider configured. Starting setup...\n");
  const io = realIO();
  try {
    const res = await runWizard(io, process.env.HOME ?? "");
    const r = resolveApiKey(res.provider);
    if (r) {
      const envName =
        res.provider === "anthropic" ? "ANTHROPIC_API_KEY" :
        res.provider === "openai" ? "OPENAI_API_KEY" :
        res.provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENCODE_API_KEY";
      process.env[envName] = r.key;
      process.env.MNEMO_PROVIDER ??= res.provider;
      if (res.defaultModel) process.env.MNEMO_MODEL ??= res.defaultModel;
    }
  } finally {
    io.close();
  }
}

/** mnemo traces [session-id] [--json] [--date YYYY-MM-DD] */
export function renderTraces(
  argv: string[],
  home = process.env.HOME ?? "",
  log: (s: string) => void = console.log,
): void {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const dateIdx = argv.indexOf("--date");
  const date = dateIdx >= 0 ? argv[dateIdx + 1] : undefined;
  const session = argv.slice(1).find((a) => !a.startsWith("--") && a !== date);

  const spans = readSpans(home, date);
  if (spans.length === 0) {
    log("(no traces yet — run mnemo once, or check MNEMO_LOG_LEVEL)");
    return;
  }
  if (flags.has("--json")) {
    log(JSON.stringify(session ? spans.filter((s) => s.session === session) : spans, null, 2));
    return;
  }
  if (session) {
    log(formatTree(spans, session));
    return;
  }
  // no session named: list them, newest last, so the id can be copied
  for (const id of sessionsOf(spans)) {
    const own = spans.filter((s) => s.session === id);
    const started = new Date(Math.min(...own.map((s) => s.start))).toISOString();
    const failed = own.filter((s) => s.ok === false).length;
    log(`${id}  ${started}  ${own.length} spans${failed ? `  ${failed} failed` : ""}`);
  }
  log("\nmnemo traces <session-id>   to see one session's span tree");
}

/** Connect to configured MCP servers before pi registers tools. */
async function loadMcpTools(): Promise<void> {
  const config = loadMcpConfig(process.env.HOME ?? undefined);
  if (Object.keys(config.servers).length === 0) return;
  const { tools, errors } = await discoverMcpTools(config);
  setMcpTools(tools);
  if (tools.length > 0) console.error(`mcp: ${tools.length} tool(s) loaded`);
  for (const e of errors) console.error(`mcp: ${e.server} unavailable — ${e.error}`);
}

async function printSkillsBanner(): Promise<void> {
  try {
    const skills = await discoverSkills();
    console.error(`skills: ${skills.length} loaded`);
  } catch {
    console.error("skills: 0 loaded");
  }
}

/** All sea extensions as pi InlineExtensions. */
function factories() {
  return [
    seaToolsInline,
    // hooks-only: the 3 memory tools are registered by sea-tools-inline
    // (pi rejects duplicate tool names across inline extensions)
    { name: "sea-memory", factory: memoryLayerHooks as any },
    approvalExt,
    tracingExt,
    hooksExt,
    schedulesExt,
  ];
}

async function run(): Promise<void> {
  // 6.2: before anything else — on an old Node the next import would fail
  // with a SyntaxError that explains nothing
  const nodeProblem = checkNodeVersion();
  if (nodeProblem) {
    console.error(nodeProblem);
    process.exit(1);
  }

  const argv = process.argv.slice(2);

  // Legacy flag kept locally (skills-store backed); everything else forwards.
  if (argv.includes("--list-sessions")) {
    await handleListSessions(); // no model/API key needed
    return;
  }
  // Help/version/pi subcommands must reach pi without a provider check.
  if (argv[0] === "auth") {
    // 8.8: the interactive wizard now lives inside mnemo-agent. `status` and
    // `logout` stay because they are useful from a script; `login` would be a
    // second, divergent onboarding flow.
    if ((argv[1] ?? "login") === "login") {
      console.error("mnemo: run `mnemo-agent` and log in there (or /login inside a session).");
      process.exit(1);
    }
    await handleAuth(argv);
    return;
  }
  // traces read a local file: no provider, no model, no network
  if (argv[0] === "traces") {
    renderTraces(argv);
    return;
  }
  // consolidation is pure memory-layer work: no provider, no model, no LLM
  if (argv[0] === "consolidate") {
    try {
      await runConsolidate(sharedMem);
    } finally {
      sharedMem.stop();
    }
    return;
  }
  // schedules/triggers read and fire from local files; the spawned children
  // carry their own auth, so this subcommand needs no provider of its own
  if (argv[0] === "schedule") {
    process.exitCode = await runSchedule(argv.slice(1), {
      home: process.env.HOME ?? "",
      cwd: process.cwd(),
      env: process.env,
      argv: argv.slice(1),
      log: (s) => console.log(s),
      err: (s) => console.error(s),
    });
    return;
  }
  const PI_SUBCOMMANDS = ["install", "remove", "uninstall", "update", "list", "config"];
  const needsOnboarding = argv.length === 0 || ["--onboard"].includes(argv[0] ?? "");
  const needsNoProvider =
    ["--help", "-h", "--version", "-v"].some((a) => argv.includes(a)) ||
    PI_SUBCOMMANDS.includes(argv[0] ?? "");
  if (needsNoProvider) {
    await main(argv, { extensionFactories: factories() });
    return;
  }
  if (argv.includes("--export") || argv.includes("--import")) {
    console.error(
      "mnemo: legacy --export/--import were removed; use pi's native " +
        "--session-dir/--resume/--fork and /share instead.",
    );
  }

  await ensureAuthenticated();

  let selection;
  try {
    selection = pickProvider();
  } catch (err: any) {
    console.error(`mnemo: ${err?.message ?? err}`);
    process.exit(2);
  }
  if (!selection || !process.env[selection.apiKeyEnv]) {
    console.error(missingKeyMessage(selection));
    process.exit(1);
  }

  const args = [...argv];
  const hasProviderFlag = args.some((a) => a === "--provider" || a.startsWith("--provider="));
  const hasModelFlag = args.some((a) => a === "--model" || a.startsWith("--model="));
  if (!hasProviderFlag) args.push("--provider", selection.provider);
  if (!hasModelFlag && selection.modelId) args.push("--model", selection.modelId);
  if (!args.includes("--no-builtin-tools")) args.push("--no-builtin-tools");

  await loadMcpTools();
  await printSkillsBanner();
  await main(args, { extensionFactories: factories() });
}

if (invokedDirectly) {
  run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
