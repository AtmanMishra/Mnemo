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
import type { MemoryNote, MemoryService } from "@mnemo/memory";
import { probeInterpreter, resolveInterpreter } from "../kernel/kernel.ts";
import { trustedBin } from "../runtime/bin.ts";
import { Checkpoints } from "../runtime/checkpoints.ts";
import { Roster, type Access } from "../runtime/roster.ts";
import { limitsOf, SettingsStore } from "../runtime/settings.ts";
import { managedPath } from "../policy/managed.ts";

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

export type { MemoryNote };

export interface HostUi {
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalAnswer>;
  note(note: MemoryNote): void;
  /** The skill set changed on disk; reload resources once the run settles. */
  resourcesChanged(): void;
}

export interface Host {
  home: string;
  agentDir: string;
  /** The administrator's policy file (policy/managed.ts); its fixed place outside tests. */
  managedFile: string;
  modelRuntime: ModelRuntime;
  /** Absent when the sidecar is not installed: memory is then simply off. */
  memory?: MemoryService;
  /** Resolved lazily; undefined when no working Python exists. */
  python: () => string | undefined;
  /** 0 for the session the user talks to, 1 for its sub-agents, … */
  depth: number;
  /** Every agent of the process as a tree (shared by all hosts; see runtime/roster.ts). */
  roster: Roster;
  /** This agent's node in the roster. */
  node: number;
  /** What this agent may do; a sub-agent never has more than its parent. */
  access: Access;
  mode: Mode;
  /** What the user tuned (shared by every agent); read at the moment of use so a change applies at once. */
  settings: SettingsStore;
  /** Extract durable facts after each run (costs one small model call). */
  reflect: boolean;
  /** Send a run that changed code and checked nothing back once, to verify. */
  verify: boolean;
  /** `provider/id` of a stronger model a run moves to when its checks keep failing. */
  escalate?: string;
  /** Every escalation this session made, oldest first. */
  escalations: { from: string; to: string; reason: string }[];
  /** Set by the memory extension: the session record learns the model changed. */
  onModelChanged?: (model: string, reason: string) => Promise<void>;
  /**
   * The code index for a folder, brought up to date, or why there is none; set by the code
   * extension (absent when `codeIndex` is off). Memory uses it to pin facts to definitions.
   */
  codeIndex?: (cwd: string) => Promise<import("../code/index.ts").CodeIndex | string>;
  /** What memory recalled in this session (node → line), set by the memory extension. */
  recalled?: Map<number, string>;
  /** Files as they were before each turn changed them (shared with sub-agents). */
  checkpoints?: Checkpoints;
  /** Absent in headless runs (`-p`). */
  ui?: HostUi;
  /** Work the extensions started and did not wait for (reflection). Tests await it. */
  background: Set<Promise<unknown>>;
  /**
   * Things the user told Mnemo outside the chat during this run — a refusal in
   * the approval dialog and what to do instead. The memory loop reads and
   * clears them after each run: they are the user's own words about how to work.
   */
  signals: string[];
  /** The episode this session is recording, once there is one. */
  episode?: number;
  /** For a sub-agent: the episode of the session that spawned it. */
  parentEpisode?: number;
  /** For a sub-agent: where the transcripts of its tree are saved (the root session's `sub/` folder); unset when that session is not saved. */
  subDir?: string;
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
  /** Tests only: production reads the fixed place, which nothing the user sets can move. */
  managedFile?: string;
  modelRuntime: ModelRuntime;
  memory?: MemoryService;
  mode?: Mode;
  /** The process's settings; defaults when absent (tests, headless runs). */
  settings?: SettingsStore;
  reflect?: boolean;
  verify?: boolean;
  escalate?: string;
  /** The process's roster; a private one when absent (tests, headless runs). */
  roster?: Roster;
  /** The root's name in the roster (the interface sets it once the fleet names the agent). */
  label?: string;
  /** Injected by tests; the default probes for a Python that actually runs. */
  python?: () => string | undefined;
}

export function createHost(o: HostOptions): Host {
  let python: string | undefined | null = null;
  const roster = o.roster ?? new Roster();
  if (o.settings) roster.setLimits(limitsOf(o.settings.get()));
  return {
    home: o.home,
    agentDir: o.agentDir,
    managedFile: o.managedFile ?? managedPath(),
    modelRuntime: o.modelRuntime,
    memory: o.memory,
    python:
      o.python ??
      (() => {
        if (python === null) python = resolveInterpreter({ which: (c) => trustedBin(c) ?? null, probe: probeInterpreter });
        return python;
      }),
    depth: 0,
    roster,
    node: roster.addRoot(o.label ?? "mnemo").id,
    access: "full",
    mode: o.mode ?? "default",
    settings: o.settings ?? new SettingsStore(),
    reflect: o.reflect ?? true,
    verify: o.verify ?? true,
    escalate: o.escalate,
    escalations: [],
    background: new Set(),
    signals: [],
    checkpoints: new Checkpoints(),
  };
}
