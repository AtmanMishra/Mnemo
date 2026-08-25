#!/usr/bin/env node
/**
 * sea-agent CLI: boots a pi AgentSession with the sea toolset.
 *
 * Usage:
 *   sea                     interactive REPL (reads prompts from stdin)
 *   sea "<prompt>"          one-shot prompt, print the answer, exit
 *   echo "prompt" | sea     pipe mode
 *
 * Provider comes from OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY.
 * Tests never invoke this module; tools are unit-tested standalone.
 */
import * as readline from "node:readline/promises";
import * as path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { allTools, toolNames } from "./tools/index.ts";
import { pickProvider, missingKeyMessage } from "./provider.ts";
import memoryLayerExtension from "../extensions/memory-layer.ts";

// Extension host shim: collects tools registered by extensions and lets us fire
// lifecycle events manually (our CLI is its own extension host).
const extTools: any[] = [];
const extHandlers: Record<string, Array<(arg?: any) => any>> = {};
memoryLayerExtension({
  on(evt: string, fn: (arg?: any) => any) {
    (extHandlers[evt] ??= []).push(fn);
  },
  registerTool(t: any) {
    extTools.push(t);
  },
} as any);
const allMergedTools: any[] = [...allTools, ...extTools];
const allMergedNames: string[] = [...toolNames, ...extTools.map((t) => t.name)];
async function fireEvent(evt: string, arg?: any): Promise<void> {
  for (const fn of extHandlers[evt] ?? []) {
    try { await fn(arg); } catch { /* memory must never break the loop */ }
  }
}

export async function resolveModel(runtime: ModelRuntime, provider: string, preferredId?: string): Promise<Model<any>> {
  const available = await runtime.getAvailable(provider);
  if (available.length === 0) {
    throw new Error(
      `No available models for provider "${provider}". Check that your API key is valid.`,
    );
  }
  if (preferredId) {
    const wanted = preferredId.replace(/^.*\//, ""); // allow "openai/gpt-x" style
    const exact = available.find((m) => m.id === wanted)
      ?? available.find((m) => m.id === preferredId); // full catalog id also allowed
    if (exact) return exact;
    console.error(`model "${preferredId}" not in catalog; falling back to first available`);
  }
  return available[0];
}

async function printAssistantText(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): Promise<void> {
  session.subscribe((event: any) => {
    if (event?.type === "message_start" && event.message?.role === "assistant") {
      // stream text updates
    }
    if (event?.type === "message_update" && event.message?.role === "assistant") {
      const deltaEvent = event.assistantMessageEvent;
      if (deltaEvent?.type === "text_delta" && deltaEvent.delta) process.stdout.write(deltaEvent.delta);
    }
    if (event?.type === "tool_execution_end") {
      const status = event.isError ? "error" : "ok";
      console.error(`\n[tool] ${event.toolName} -> ${status}`);
      void fireEvent("tool_execution_end", { toolName: event.toolName, isError: !!event.isError });
    }
  });
}

async function main(): Promise<void> {
  const selection = (() => {
    try {
      return pickProvider();
    } catch (err) {
      console.error(String(err));
      process.exit(2);
    }
  })();
  if (!selection) {
    console.error(missingKeyMessage(null));
    process.exit(1);
  }

  const promptArgs = process.argv.slice(2).filter((a) => a !== "--");
  const oneShotPrompt = promptArgs.length > 0 ? promptArgs.join(" ") : undefined;

  const modelRuntime = await ModelRuntime.create();
  let session;
  try {
    const model = await resolveModel(modelRuntime, selection.provider, selection.modelId);
    console.error(`sea-agent: provider=${selection.provider} model=${model.provider}/${model.id}`);
    ({ session } = await createAgentSession({
      cwd: process.cwd(),
      sessionManager: SessionManager.inMemory(process.cwd()),
      customTools: allMergedTools as any,
      tools: allMergedNames, // allowlist: only our tools are active
      model,
    }));
  } catch (err: any) {
    console.error(`sea-agent: failed to start session: ${err?.message ?? err}`);
    process.exit(1);
  }

  await printAssistantText(session);
  await fireEvent("session_start");

  if (oneShotPrompt) {
    await session.prompt(oneShotPrompt);
    await fireEvent("session_shutdown");
    await session.dispose();
    return;
  }

  const rl = readline.createInterface({ input, output });
  console.error('sea-agent REPL ready. Type a prompt, or "/exit" to quit.');
  try {
    while (true) {
      const line = await rl.question("> ");
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "/exit" || trimmed === "/quit") break;
      await session.prompt(trimmed);
      process.stdout.write("\n");
    }
  } catch {
    // stdin closed
  } finally {
    rl.close();
    await session.dispose();
  }
}

export const SEA_CLI_FORCE = process.env.SEA_CLI_FORCE === "1";

/** Invoked by bin/sea.ts once it has decided this process is the CLI. */
export function runCliIfMain(): void {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
