#!/usr/bin/env node
// mnemo CLI entry: thin shim over pi's main().
//
// Usage:
//   mnemo "<prompt>"          one-shot prompt (pi print mode when non-TTY)
//   mnemo                     interactive TUI (pi interactive mode)
//   mnemo consolidate         distil recurring episodes into semantic lessons
//   mnemo traces [session]    print span trees from ~/.mnemo/logs (--json)
//   mnemo init [--dry-run|--yes]   propose the project-memory file pi loads
//   mnemo pr [--base R] [--dry-run] [--review]
//                             open a PR for this branch, titled and described
//                             from its commits (never force-pushes)
//
// MCP servers listed in ~/.mnemo/mcp.json are connected before pi starts and
// their tools registered as mcp__<server>__<tool>.
//   mnemo --list-sessions     list saved sessions from ~/.sea/sessions and exit
//   mnemo --help              pi's own help
//
// Everything else is forwarded to @earendil-works/pi-coding-agent's main():
// provider/model come from pickProvider() unless the user passed explicit
// flags, and --no-builtin-tools keeps only OUR tools active.
//
// Provider credentials: Mnemo runs on a key of its own (~/.mnemo/auth.json, or
// the environment) OR on one pi already holds — a subscription from pi's own
// /login, or a local model server. Only a run with no credential anywhere is
// refused, and that message names both routes (see ensureAuthenticated).
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
import { canStart, pickProvider, missingKeyMessage, piDefaultModel } from "../src/provider.ts";
import { credentials } from "../src/auth/pi_store.ts";
import * as readline from "node:readline/promises";
import {
  PROVIDERS, ENV_KEY_BY_PROVIDER, loadAuth, resolveApiKey, clearProviderAuth,
  setProviderAuth, setDefaultProvider, type ProviderId,
} from "../src/auth/store.ts";
import { runWizard } from "../src/auth/wizard.ts";
import { seaToolsInline } from "../extensions/sea-tools-inline.ts";
import { memoryLayerHooks, runConsolidate, sharedMem } from "../extensions/memory-layer.ts";
import { discoverMcpTools, loadMcpConfig, setMcpTools } from "../src/mcp.ts";
import { formatTree, readSpans, sessionsOf } from "../src/trace.ts";
import { runSchedule } from "../src/schedule/cli.ts";
import { runInit } from "../src/init.ts";
import { runPr } from "../src/pr.ts";
import { checkNodeVersion } from "../src/runtime_check.ts";
import { setAgentProcessMarkers } from "../src/childenv.ts";
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

export async function handleListSessions(): Promise<void> {
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
export async function handleAuth(args: string[]): Promise<void> {
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
      const inEnv = Boolean(process.env[ENV_KEY_BY_PROVIDER[p]]);
      const state = inEnv ? "env key" : stored?.key || stored?.accessToken ? "stored" : "-";
      const def = auth.defaultProvider === p ? "  <- default" : "";
      console.log(`${p.padEnd(14)} ${state.padEnd(9)} ${def}`);
    }
    // pi's own credentials are just as usable as ours — a subscription, or a
    // local router with no key at all — so a status that hid them would tell
    // someone who can run that they cannot (#23).
    const viaPi = credentials(process.env);
    console.log(viaPi.length > 0
      ? `\npi:  ${viaPi.join(", ")}  (stored by pi; Mnemo needs no key of its own for these)`
      : "\npi:  none stored — `pi` then /login for a subscription, or configure a local model");
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

/**
 * Arranges the credentials a run needs, and refuses only when there are none
 * anywhere.
 *
 * Two halves, in that order. Mnemo's own: an environment variable, or a key in
 * ~/.mnemo/auth.json (exported into the environment pi reads). Then pi's:
 * a subscription token or a local router in ~/.pi/agent/auth.json needs no
 * help from us — and refusing a run on a credential pi holds is exactly the
 * bug that locked subscription and local-model testers out (#23).
 *
 * Returns whether anything at all can run a model.
 */
export async function ensureAuthenticated(): Promise<boolean> {
  const forced = (process.env.MNEMO_PROVIDER ?? process.env.SEA_PROVIDER)?.trim();
  const selection = pickProvider();
  // Normalised the way pickProvider normalises it, so `MNEMO_PROVIDER=OpenAI`
  // looks up OPENAI_API_KEY and not the variable named "OpenAI".
  const asked = forced ? forced.toLowerCase() : undefined;

  // A key already in the environment is the whole job.
  if (selection && selection.apiKeyEnv && process.env[selection.apiKeyEnv]) return true;
  // A provider Mnemo has no key for is pi's: nothing of ours to find, and
  // nothing of ours to export (a foreign key in the environment would be
  // worse than none).
  if (selection && !selection.apiKeyEnv) return true;

  // Mnemo's store: the provider asked for — the ONLY one, when one was asked
  // for, or a stored model id from another provider would be handed to it —
  // else the stored default first, then the rest.
  const auth = loadAuth();
  const candidates: ProviderId[] = asked
    ? [asked as ProviderId]
    : auth.defaultProvider
      ? [auth.defaultProvider, ...(PROVIDERS as readonly ProviderId[]).filter((p) => p !== auth.defaultProvider)]
      : [...(PROVIDERS as readonly ProviderId[])];
  for (const p of candidates) {
    const r = resolveApiKey(p);
    if (!r?.key) continue;
    process.env[ENV_KEY_BY_PROVIDER[p]] = r.key;
    if (!process.env.SEA_PROVIDER && !process.env.MNEMO_PROVIDER) {
      process.env.MNEMO_PROVIDER = p;
    }
    if (!process.env.MNEMO_MODEL && !process.env.SEA_MODEL) {
      const model = auth.providers[p]?.defaultModel;
      if (model) process.env.MNEMO_MODEL = model;
    }
    return true;
  }

  // Nothing of Mnemo's. pi may still have a credential of its own — a
  // subscription from pi's /login, or a local llama.cpp router — and then
  // there is nothing to arrange: run pi and let it use what it has.
  if (canStart(selection)) return true;

  // Nothing anywhere. The wizard when there is someone to ask...
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  console.error("No provider configured. Starting setup...\n");
  const io = realIO();
  try {
    const res = await runWizard(io, process.env.HOME ?? "");
    const r = resolveApiKey(res.provider);
    if (r) {
      const envName = ENV_KEY_BY_PROVIDER[res.provider];
      process.env[envName] = r.key;
      process.env.MNEMO_PROVIDER ??= res.provider;
      if (res.defaultModel) process.env.MNEMO_MODEL ??= res.defaultModel;
      return true;
    }
  } finally {
    io.close();
  }
  return false;
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
export async function loadMcpTools(): Promise<void> {
  const config = loadMcpConfig(process.env.HOME ?? undefined);
  if (Object.keys(config.servers).length === 0) return;
  const { tools, errors } = await discoverMcpTools(config);
  setMcpTools(tools);
  if (tools.length > 0) console.error(`mcp: ${tools.length} tool(s) loaded`);
  for (const e of errors) console.error(`mcp: ${e.server} unavailable — ${e.error}`);
}

export async function printSkillsBanner(): Promise<void> {
  try {
    const skills = await discoverSkills();
    console.error(`skills: ${skills.length} loaded`);
  } catch {
    console.error("skills: 0 loaded");
  }
}

/** All sea extensions as pi InlineExtensions. */
export function factories() {
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
  // D6 (docs/environment-variables.md:11-18): pi's CLI and RPC entry points
  // set these two process markers so children can identify the launching
  // agent; we call pi's library main() instead of its CLI, so nobody would.
  // Set unconditionally, like pi does, before any child can be spawned.
  setAgentProcessMarkers();

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
    // 8.8: the interactive wizard now lives inside the TUI (`mnemo`, then
    // /login). `status` and `logout` stay because they are useful from a
    // script; `login` would be a second, divergent onboarding flow.
    if ((argv[1] ?? "login") === "login") {
      console.error("mnemo: run `mnemo` and log in there (/login inside the interface).");
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
  // `/init` (issue #8): project memory is local files — no provider, no model,
  // no network. It proposes, and the operator consents (see src/init.ts).
  if (argv[0] === "init") {
    process.exitCode = await runInit(argv.slice(1), {
      cwd: process.cwd(),
      home: process.env.HOME ?? process.env.USERPROFILE ?? "",
      env: process.env,
      log: (s) => console.log(s),
      err: (s) => console.error(s),
    });
    return;
  }
  // PR automation (issue #8): git and gh carry their own credentials, so this
  // needs no provider of ours either. It refuses to force-push, ever.
  if (argv[0] === "pr") {
    process.exitCode = await runPr(argv.slice(1), {
      cwd: process.cwd(),
      home: process.env.HOME ?? process.env.USERPROFILE ?? "",
      env: process.env,
      log: (s) => console.log(s),
      err: (s) => console.error(s),
    });
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

  // The one gate, and it now asks the whole question: Mnemo's key, or pi's
  // own credential. A provider pi can drive is passed through with no key of
  // ours at all, and a name pi does not know is pi's error to give — which
  // reaches the transcript, since the interface carries pi's stderr now.
  if (!(await ensureAuthenticated())) {
    console.error(missingKeyMessage(pickProvider()));
    console.error("or run `mnemo` and log in from inside the interface (/login)");
    process.exit(1);
  }

  const selection = pickProvider();
  const args = [...argv];
  const hasProviderFlag = args.some((a) => a === "--provider" || a.startsWith("--provider="));
  const hasModelFlag = args.some((a) => a === "--model" || a.startsWith("--model="));
  if (!hasProviderFlag && selection) args.push("--provider", selection.provider);
  // Mnemo's model first; pi's stored default when Mnemo's is unset and it
  // describes the same provider. Passing nothing is not a gap: pi then uses
  // its own defaultModel, which is the answer we would have copied.
  const model = selection?.modelId || (selection ? piDefaultModel(selection.provider) : undefined);
  if (!hasModelFlag && model) args.push("--model", model);
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
