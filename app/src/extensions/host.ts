/**
 * What Mnemo's pi extensions share with the application and with each other.
 *
 * The extensions are inline (shipped in the binary), so instead of reaching for
 * globals they receive one host: where state lives, the model runtime, the
 * memory service, and — when there is an interface — a way to ask the user and
 * to put a line in the transcript. A sub-agent gets a copy of its parent's host
 * with `depth + 1`, so approvals and memory are shared and nesting is bounded.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ApprovalAnswer, ApprovalRequest } from "../runtime/dialogs.ts";
import type { MemoryService } from "../memory/service.ts";
import { probeInterpreter, resolveInterpreter } from "../kernel/kernel.ts";

/**
 * How much Mnemo may do without asking.
 *   default       read freely; ask before edits and commands
 *   accept-edits  edit files inside the project freely; still ask before commands
 *   plan          read-only: edits and commands are refused
 *   yolo          ask for nothing (rules that deny still deny)
 */
export type Mode = "default" | "accept-edits" | "plan" | "yolo";

/** shift+tab cycles these; yolo is only ever chosen explicitly. */
export const CYCLE: Mode[] = ["default", "accept-edits", "plan"];

export type MemoryNote =
  | { kind: "recall"; items: string[] }
  | { kind: "learned"; items: string[] }
  | { kind: "steer"; text: string }
  | { kind: "skill"; text: string };

export interface HostUi {
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalAnswer>;
  note(note: MemoryNote): void;
  /** The skill set changed on disk; reload resources once the run settles. */
  resourcesChanged(): void;
}

export interface Host {
  home: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  /** Absent when the sidecar is not installed: memory is then simply off. */
  memory?: MemoryService;
  /** Resolved lazily; undefined when no working Python exists. */
  python: () => string | undefined;
  /** 0 for the session the user talks to, 1 for its sub-agents, … */
  depth: number;
  maxDepth: number;
  mode: Mode;
  /** Extract durable facts after each run (costs one small model call). */
  reflect: boolean;
  /** Absent in headless runs (`-p`). */
  ui?: HostUi;
  /** Work the extensions started and did not wait for (reflection). Tests await it. */
  background: Set<Promise<unknown>>;
}

/** Run something after the fact without letting it fail the turn, and keep track of it. */
export function inBackground(host: Host, work: () => Promise<unknown>): void {
  const p = work()
    .catch(() => {})
    .finally(() => host.background.delete(p));
  host.background.add(p);
}

export async function settleBackground(host: Host): Promise<void> {
  while (host.background.size > 0) await Promise.all([...host.background]);
}

export interface HostOptions {
  home: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  memory?: MemoryService;
  mode?: Mode;
  reflect?: boolean;
  maxDepth?: number;
  /** Injected by tests; the default probes for a Python that actually runs. */
  python?: () => string | undefined;
}

export function createHost(o: HostOptions): Host {
  let python: string | undefined | null = null;
  return {
    home: o.home,
    agentDir: o.agentDir,
    modelRuntime: o.modelRuntime,
    memory: o.memory,
    python:
      o.python ??
      (() => {
        if (python === null) python = resolveInterpreter({ which: (c) => Bun.which(c), probe: probeInterpreter });
        return python;
      }),
    depth: 0,
    maxDepth: o.maxDepth ?? 2,
    mode: o.mode ?? "default",
    reflect: o.reflect ?? true,
    background: new Set(),
  };
}
