/**
 * Drives Mnemo the way a person would — one session at a time, in a real
 * project directory, against a real model — without a terminal.
 *
 * Each session is a fresh pi runtime with Mnemo's extensions over a shared
 * home (so memory carries between sessions exactly as it would for a user).
 * Dialogs are answered automatically and recorded: approvals yes, questions
 * no answer. What happened is collected from the controller's transcript,
 * which is what the user would have seen.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, type FauxProviderHandle, type FauxResponseStep, type Model } from "@earendil-works/pi-ai";
import { startRuntime, createModelRuntime } from "../src/runtime/runtime.ts";
import { Controller } from "../src/runtime/controller.ts";
import { createFaux } from "../src/runtime/demo.ts";
import { MemoryService } from "@mnemo/memory";
import { createHost, settleBackground, type Mode } from "../src/extensions/host.ts";
import { mnemoExtensions } from "../src/extensions/index.ts";
import { hermesExtension, HermesStore } from "./hermes.ts";
import { findMemsrv, journalPath } from "../src/runtime/paths.ts";
import type { Block } from "../src/ui/store.ts";

export interface EvalModel {
  modelRuntime: ModelRuntime;
  model: Model<any>;
  label: string;
  faux?: FauxProviderHandle;
}

/** The real model, or a clear reason it cannot be used. */
export async function realModel(agentDir: string, spec: string): Promise<EvalModel> {
  const [provider, ...rest] = spec.split("/");
  const id = rest.join("/");
  const modelRuntime = await createModelRuntime(agentDir);
  const model = modelRuntime.getModel(provider!, id);
  if (!model) throw new Error(`pi does not know the model ${spec}`);
  if (!modelRuntime.hasConfiguredAuth(provider!))
    throw new Error(`no credentials for ${provider} — set OPENCODE_API_KEY in the environment (and allow opencode.ai in its network settings)`);
  return { modelRuntime, model, label: spec };
}

/**
 * A stand-in model that answers every request with a short line (and the
 * reflection call with an empty result), for checking the harness itself.
 */
export async function fauxModel(agentDir: string): Promise<EvalModel> {
  const { modelRuntime, faux } = await createFaux(agentDir);
  const step: FauxResponseStep = (context) => {
    const system = JSON.stringify((context as { messages?: { role: string; content: unknown }[] }).messages?.[0]?.content ?? "");
    return system.includes("long-term memory of Mnemo")
      ? fauxAssistantMessage(fauxText('{"facts":[],"fixes":[],"skill":null}'))
      : fauxAssistantMessage(fauxText("(faux model) done."));
  };
  faux.setResponses(Array.from({ length: 2000 }, () => step));
  return { modelRuntime, model: faux.getModel(), label: "faux", faux };
}

export interface ToolRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
}

export interface SessionResult {
  prompts: string[];
  answers: string[];
  tools: ToolRecord[];
  memory: string[];
  approvals: string[];
  tokens: { input: number; output: number; cacheRead: number };
  cost: number;
  ms: number;
  errors: string[];
}

export interface SessionOptions {
  home: string;
  cwd: string;
  model: EvalModel;
  memory: boolean;
  /** A Hermes-Agent-style memory instead of Mnemo's (eval/hermes.ts); `memory` must be false. */
  hermes?: boolean;
  mode?: Mode;
  /** Abort a prompt that runs longer than this. */
  promptTimeoutMs?: number;
}

function blockText(b: Block): string {
  return "text" in b ? b.text : "";
}

/** One session: open, send each prompt in turn, wait for memory to settle, close. */
export async function runSession(o: SessionOptions, prompts: string[]): Promise<SessionResult> {
  const agentDir = path.join(o.home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const memsrv = o.memory ? findMemsrv(o.home) : undefined;
  if (o.memory && !memsrv) throw new Error("memory requested but memsrv is not built (cd memory-layer && cargo build --release --bin memsrv)");
  const memory = memsrv ? new MemoryService(memsrv, journalPath(o.home)) : undefined;
  const host = createHost({ home: o.home, agentDir, modelRuntime: o.model.modelRuntime, memory, mode: o.mode ?? "yolo", reflect: o.memory || !!o.hermes });
  const runtime = await startRuntime({
    cwd: o.cwd,
    agentDir,
    modelRuntime: o.model.modelRuntime,
    model: o.model.model,
    sessionManager: SessionManager.inMemory(o.cwd),
    extensions: [...mnemoExtensions(host), ...(o.hermes ? [hermesExtension(host, new HermesStore(path.join(o.home, "hermes", "memories")))] : [])],
  });
  const controller = new Controller(runtime, { exit: () => {}, host });
  await controller.bind();
  const approvals: string[] = [];
  const unsubscribe = controller.dialogs.subscribe(() => {
    const d = controller.dialogs.current();
    if (!d) return;
    if (d.kind === "approval") {
      approvals.push(`${d.request.tool}(${d.request.subject})`);
      d.resolve({ kind: "yes" });
    } else if (d.kind === "confirm") d.resolve(true);
    else d.resolve(undefined);
  });
  const started = Date.now();
  const errors: string[] = [];
  try {
    for (const prompt of prompts) {
      const timer = setTimeout(() => {
        errors.push(`timed out: ${prompt.slice(0, 60)}`);
        controller.interrupt();
      }, o.promptTimeoutMs ?? 6 * 60_000);
      try {
        await controller.submit(prompt);
        await controller.session.waitForIdle();
        await settleBackground(host);
      } finally {
        clearTimeout(timer);
      }
    }
    // Background work (reflection) can open a dialog after the run settles.
    await new Promise((r) => setTimeout(r, 100));
    await settleBackground(host);
  } finally {
    unsubscribe();
  }
  const blocks = controller.transcript.snapshot().committed;
  const stats = controller.session.getSessionStats();
  const result: SessionResult = {
    prompts,
    answers: blocks.filter((b) => b.kind === "assistant").map(blockText),
    tools: blocks
      .filter((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool")
      .map((b) => ({ name: b.name, args: b.args, ok: b.status === "done", output: b.output.slice(0, 2000) })),
    memory: blocks.filter((b) => b.kind === "memory").map((b) => (b.kind === "memory" ? `${b.title}: ${b.items.join(" | ")}` : "")),
    approvals,
    tokens: { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead },
    cost: stats.cost,
    ms: Date.now() - started,
    errors: [...errors, ...blocks.filter((b) => b.kind === "notice" && b.tone !== "info").map(blockText)],
  };
  await runtime.dispose();
  memory?.stop();
  return result;
}
