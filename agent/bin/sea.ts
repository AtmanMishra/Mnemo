#!/usr/bin/env node
// sea-agent CLI entry.
//
// Usage:
//   sea "<prompt>"            one-shot prompt, print the answer, exit
//   sea                       interactive REPL
//   sea --list-sessions       list saved sessions from ~/.sea/sessions and exit
//   sea --import <file> "p"   print imported-transcript scrollback header, then run normally.
//                             v1 limitation: imported messages are shown as a header only;
//                             they are NOT re-fed to the model as context.
//   sea --export <file> "p"   after the one-shot session, write the transcript to <file>
//                             in JSONL format ({role,content} per line).
//
// src/cli.ts is stable/read-only for skill-system changes, so flag parsing,
// the skills boot banner, and the export flow live here.
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { runCliIfMain, SEA_CLI_FORCE } from "../src/cli.ts";
import { discoverSkills } from "../src/skills/discovery.ts";
import {
  listSessions,
  loadSession,
  defaultSessionDir,
  exportSession,
  type SessionMessage,
} from "../src/skills/store.ts";
import { pickProvider } from "../src/provider.ts";
import { allTools, toolNames } from "../src/tools/index.ts";
import { resolveModel } from "../src/cli.ts";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();

interface Flags {
  listSessions?: boolean;
  exportFile?: string;
  importFile?: string;
}

function parseFlags(argv: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list-sessions") flags.listSessions = true;
    else if (a === "--export") flags.exportFile = argv[++i] ?? fail("--export requires a file argument");
    else if (a === "--import") flags.importFile = argv[++i] ?? fail("--import requires a file argument");
    else rest.push(a);
  }
  return { flags, rest };
}

function fail(msg: string): never {
  console.error(`sea-agent: ${msg}`);
  process.exit(2);
}

async function printSkillsBanner(): Promise<void> {
  try {
    const skills = await discoverSkills();
    console.error(`skills: ${skills.length} loaded`);
  } catch {
    console.error("skills: 0 loaded");
  }
}

/** v1 import: printed scrollback header only; messages are NOT re-fed to the model. */
async function printImportHeader(file: string): Promise<void> {
  let messages: SessionMessage[];
  try {
    messages = await loadImportable(file);
  } catch (err: any) {
    fail(`--import failed: ${err?.message ?? err}`);
  }
  console.error(
    `sea-agent: imported ${messages.length} message(s) from ${file} as scrollback context ` +
      `(v1: printed header only — these messages are NOT re-fed to the model).`,
  );
  const preview = messages.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 80)}`);
  if (preview.length > 0) console.error(["--- transcript tail ---", ...preview].join("\n"));
}

async function loadImportable(file: string): Promise<SessionMessage[]> {
  const { importSession } = await import("../src/skills/store.ts");
  // Named sessions can be referenced as "name:<name>"; anything else is a path.
  if (file.startsWith("name:")) {
    const { loadSession } = await import("../src/skills/store.ts");
    return loadSession(defaultSessionDir(), file.slice("name:".length));
  }
  return importSession(file);
}

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

/**
 * One-shot run with transcript export. Mirrors cli.ts's boot recipe because
 * cli.ts is read-only and does not expose its session object.
 */
async function runOneShotWithExport(prompt: string, exportFile: string): Promise<void> {
  const selection = pickProvider();
  if (!selection) fail(missingKey());
  const modelRuntime = await ModelRuntime.create();
  const model = await resolveModel(modelRuntime, selection.provider, selection.modelId);
  console.error(`sea-agent: provider=${selection.provider} model=${model.provider}/${model.id}`);
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    sessionManager: SessionManager.inMemory(process.cwd()),
    customTools: allTools as any,
    tools: toolNames,
    model,
  });
  session.subscribe((event: any) => {
    if (event?.type === "message_update" && event.message?.role === "assistant") {
      const deltaEvent = event.assistantMessageEvent;
      if (deltaEvent?.type === "text_delta" && deltaEvent.delta) process.stdout.write(deltaEvent.delta);
    }
    if (event?.type === "tool_execution_end") {
      console.error(`\n[tool] ${event.toolName} -> ${event.isError ? "error" : "ok"}`);
    }
  });
  try {
    await session.prompt(prompt);
    const messages: SessionMessage[] = (session.messages as any[]).map((m) => ({
      role: String(m.role),
      content:
        typeof m.content === "string"
          ? m.content
          : (Array.isArray(m.content) ? m.content : [])
              .filter((b: any) => b?.type === "text")
              .map((b: any) => b.text ?? "")
              .join("\n"),
    }));
    const file = await exportSession(exportFile, messages);
    console.error(`\nsea-agent: exported ${messages.length} message(s) to ${file}`);
  } finally {
    await session.dispose();
  }
}

function missingKey(): string {
  // Lazy require avoided; reuse provider helper text via dynamic import is overkill
  // for an error path, so keep it short here.
  return "no API key found (OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY)";
}

if (invokedDirectly || SEA_CLI_FORCE) {
  const { flags, rest } = parseFlags(process.argv.slice(2));
  const promptArgs = rest.filter((a) => a !== "--");
  const oneShotPrompt = promptArgs.length > 0 ? promptArgs.join(" ") : undefined;

  if (flags.listSessions) {
    await handleListSessions(); // no model/API key needed
  } else if (flags.exportFile && oneShotPrompt) {
    await printSkillsBanner();
    await runOneShotWithExport(oneShotPrompt, flags.exportFile);
  } else {
    await printSkillsBanner();
    if (flags.importFile) await printImportHeader(flags.importFile);
    if (flags.exportFile && !oneShotPrompt) {
      console.error("sea-agent: warning: --export currently supports one-shot mode only; ignoring.");
    }
    runCliIfMain();
  }
}
