#!/usr/bin/env node
// sea-agent CLI entry: thin shim over pi's main().
//
// Usage:
//   sea "<prompt>"            one-shot prompt (pi print mode when non-TTY)
//   sea                       interactive TUI (pi interactive mode)
//   sea --list-sessions       list saved sessions from ~/.sea/sessions and exit
//   sea --help                pi's own help
//
// Everything else is forwarded to @earendil-works/pi-coding-agent's main():
// provider/model come from pickProvider() unless the user passed explicit
// flags, and --no-builtin-tools keeps only OUR tools active.
// Our extensions run identically in every mode via extensionFactories:
//   sea-tools-inline (all 14 tools), memory-layer (memory tools + lifecycle
//   hooks + persistent-memory directive), approval-gate (y/n gate on
//   bash_exec/write_file/apply_edit in interactive+TTY).
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { main } from "@earendil-works/pi-coding-agent";
import { discoverSkills } from "../src/skills/discovery.ts";
import { listSessions, defaultSessionDir } from "../src/skills/store.ts";
import { pickProvider, missingKeyMessage } from "../src/provider.ts";
import { seaToolsInline } from "../extensions/sea-tools-inline.ts";
import { memoryLayerHooks } from "../extensions/memory-layer.ts";
import approvalExt from "../extensions/approval-gate.ts";

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
  ];
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);

  // Legacy flag kept locally (skills-store backed); everything else forwards.
  if (argv.includes("--list-sessions")) {
    await handleListSessions(); // no model/API key needed
    return;
  }
  // Help/version/pi subcommands must reach pi without a provider check.
  const PI_SUBCOMMANDS = ["auth", "install", "remove", "uninstall", "update", "list", "config"];
  const needsNoProvider =
    ["--help", "-h", "--version", "-v"].some((a) => argv.includes(a)) ||
    PI_SUBCOMMANDS.includes(argv[0] ?? "");
  if (needsNoProvider) {
    await main(argv, { extensionFactories: factories() });
    return;
  }
  if (argv.includes("--export") || argv.includes("--import")) {
    console.error(
      "sea-agent: legacy --export/--import were removed; use pi's native " +
        "--session-dir/--resume/--fork and /share instead.",
    );
  }

  let selection;
  try {
    selection = pickProvider();
  } catch (err: any) {
    console.error(`sea-agent: ${err?.message ?? err}`);
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

  await printSkillsBanner();
  await main(args, { extensionFactories: factories() });
}

if (invokedDirectly) {
  run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
