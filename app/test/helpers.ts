/**
 * A whole Mnemo (pi session + Mnemo's extensions + controller) on a scripted
 * model, in a throwaway home. The memory layer is real when `memsrv` has been
 * built; tests that need it skip otherwise and say so.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startRuntime } from "../src/runtime/runtime.ts";
import { Controller } from "../src/runtime/controller.ts";
import { createDemoProject, createFaux } from "../src/runtime/demo.ts";
import { MemoryService } from "../src/memory/service.ts";
import { createHost, settleBackground, type Mode } from "../src/extensions/host.ts";
import { mnemoExtensions } from "../src/extensions/index.ts";
import { findMemsrv } from "../src/runtime/paths.ts";

export const MEMSRV = findMemsrv("/nonexistent");

export interface EnvOptions {
  memory?: boolean;
  mode?: Mode;
  reflect?: boolean;
  /** Reuse a home (and so its journal) from an earlier env: a second session. */
  home?: string;
  cwd?: string;
  persistent?: boolean;
}

export async function mnemoEnv(o: EnvOptions = {}) {
  const home = o.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-home-"));
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cwd = o.cwd ?? createDemoProject();
  const { modelRuntime, faux } = await createFaux(agentDir);
  const memory = o.memory && MEMSRV ? new MemoryService(MEMSRV, path.join(home, "memory", "journal.jsonl")) : undefined;
  const host = createHost({ home, agentDir, modelRuntime, memory, mode: o.mode, reflect: o.reflect ?? false });
  const runtime = await startRuntime({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    sessionManager: o.persistent ? undefined : SessionManager.inMemory(cwd),
    extensions: mnemoExtensions(host),
  });
  const controller = new Controller(runtime, { exit: () => {}, host });
  await controller.bind();
  return {
    home,
    cwd,
    faux,
    host,
    runtime,
    controller,
    memory,
    /** Wait for the run and anything it left running in the background. */
    async idle() {
      await controller.session.waitForIdle();
      await settleBackground(host);
    },
    async close() {
      await runtime.dispose();
      memory?.stop();
    },
  };
}

/** The next dialog to open, or a failure if none does. */
export async function nextDialog(controller: Controller, ms = 2000) {
  for (let waited = 0; waited < ms; waited += 10) {
    const d = controller.dialogs.current();
    if (d) return d;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no dialog opened");
}

export function texts(controller: Controller): string[] {
  return controller.transcript.snapshot().committed.map((b) =>
    b.kind === "memory" ? `◈ ${b.title}: ${b.items.join(" | ")}` : "text" in b ? `${b.kind}: ${b.text}` : b.kind === "tool" ? `tool ${b.name} ${b.status}: ${b.output}` : b.kind,
  );
}
