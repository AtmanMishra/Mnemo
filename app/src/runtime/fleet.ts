/**
 * Every agent this process runs: one per open conversation, each with its own
 * project, pi session, host and controller. They share the memory sidecar and
 * the model credentials, so what one learns the others can recall.
 *
 * The interface reads a snapshot and calls open/close/focus; it never builds an
 * agent itself. Closing the last agent ends the program.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Controller } from "./controller.ts";
import type { Host } from "../extensions/host.ts";
import type { WorkspaceSource } from "../ui/workspace/model.ts";

export interface Agent {
  id: number;
  /** The project's folder name, numbered when two agents share a project. */
  name: string;
  cwd: string;
  controller: Controller;
  host: Host;
  source: WorkspaceSource;
}

export interface Spawned {
  controller: Controller;
  host: Host;
  source: WorkspaceSource;
}

/** Build one agent in `cwd`; `exit` is what its controller calls when it quits. */
export type Spawn = (cwd: string, exit: (code?: number) => void) => Promise<Spawned>;

/** What this run of the program did, across every agent: the exit card. */
export interface FleetSummary {
  agents: number;
  turns: number;
  /** Files edited or written. */
  files: number;
  /** Facts learned. */
  learned: number;
  cost: number;
  startedAt: number;
}

export interface FleetSnapshot {
  agents: readonly Agent[];
  /** Folders opened before, most recent first. */
  recent: readonly string[];
  summary: FleetSummary;
}

/** One agent's share of the summary, read from its transcript and footer. */
export function agentSummary(a: Pick<Agent, "controller">): Omit<FleetSummary, "agents" | "startedAt"> {
  const blocks = a.controller.transcript.snapshot().committed;
  const files = new Set<string>();
  let turns = 0;
  let learned = 0;
  for (const b of blocks) {
    if (b.kind === "user") turns++;
    if (b.kind === "tool" && (b.name === "edit" || b.name === "write") && b.status === "done") files.add(String(b.args.path ?? b.args.file_path ?? ""));
    if (b.kind === "memory" && /^Learned/.test(b.title)) learned += b.items.length;
  }
  return { turns, files: files.size, learned, cost: a.controller.snapshot().footer.cost };
}

const RECENT_MAX = 20;

export class Fleet {
  private agents: Agent[] = [];
  private recent: string[];
  private nextId = 1;
  private listeners = new Set<() => void>();
  private snap: FleetSnapshot;
  /** What closed agents did. */
  private done: FleetSummary;

  constructor(
    private readonly spawn: Spawn,
    private readonly o: {
      /** Called when the last agent has closed. */
      onEmpty: (code: number) => void;
      recent?: string[];
      /** Persist the recent list (state.json). */
      saveRecent?: (recent: string[]) => void;
      now?: () => number;
    },
  ) {
    this.recent = (o.recent ?? []).slice(0, RECENT_MAX);
    this.done = { agents: 0, turns: 0, files: 0, learned: 0, cost: 0, startedAt: (o.now ?? Date.now)() };
    this.snap = { agents: [], recent: this.recent, summary: this.done };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): FleetSnapshot => this.snap;

  private changed(): void {
    this.snap = { agents: [...this.agents], recent: [...this.recent], summary: this.summary() };
    for (const fn of this.listeners) fn();
  }

  /** Add an agent built elsewhere (the first one, made before the interface). */
  adopt(cwd: string, spawned: Spawned): Agent {
    const agent = { id: this.nextId++, name: this.nameFor(cwd), cwd, ...spawned };
    this.agents.push(agent);
    this.remember(cwd);
    this.changed();
    return agent;
  }

  /** A new agent in `cwd` (a second one in the same project is fine: it runs in parallel). */
  async open(cwd: string): Promise<Agent> {
    const dir = path.resolve(cwd);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
    const id = this.nextId++;
    const spawned = await this.spawn(dir, () => this.closed(id));
    const agent = { id, name: this.nameFor(dir), cwd: dir, ...spawned };
    this.agents.push(agent);
    this.remember(dir);
    this.changed();
    return agent;
  }

  /** Ask an agent to quit; it leaves the fleet once its session is closed. */
  async close(id: number): Promise<void> {
    await this.agents.find((a) => a.id === id)?.controller.quit();
  }

  /** Everything done so far: closed agents and open ones. */
  summary(): FleetSummary {
    const s = { ...this.done };
    for (const a of this.agents) {
      const x = agentSummary(a);
      s.agents++;
      s.turns += x.turns;
      s.files += x.files;
      s.learned += x.learned;
      s.cost += x.cost;
    }
    return s;
  }

  /** The exit callback each controller was given. */
  closed(id: number, code = 0): void {
    const leaving = this.agents.find((a) => a.id === id);
    if (!leaving) return;
    const x = agentSummary(leaving);
    this.done = { ...this.done, agents: this.done.agents + 1, turns: this.done.turns + x.turns, files: this.done.files + x.files, learned: this.done.learned + x.learned, cost: this.done.cost + x.cost };
    this.agents = this.agents.filter((a) => a.id !== id);
    this.changed();
    if (this.agents.length === 0) this.o.onEmpty(code);
  }

  /** Close every agent (quitting the program). */
  async closeAll(): Promise<void> {
    for (const a of [...this.agents]) await a.controller.quit();
  }

  private nameFor(cwd: string): string {
    const base = path.basename(cwd) || cwd;
    const same = this.agents.filter((a) => a.cwd === cwd).length;
    return same === 0 ? base : `${base}·${same + 1}`;
  }

  private remember(cwd: string): void {
    this.recent = [cwd, ...this.recent.filter((r) => r !== cwd)].slice(0, RECENT_MAX);
    this.o.saveRecent?.(this.recent);
  }
}

/**
 * Folders worth offering in the project switcher: open agents' and recent
 * ones first, then the siblings of the current project (other checkouts next
 * to it), each once.
 */
export function projectCandidates(snap: Pick<FleetSnapshot, "agents" | "recent">, current: string | undefined): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p) && fs.existsSync(p)) out.push(p);
  };
  for (const a of snap.agents) add(a.cwd);
  for (const r of snap.recent) add(r);
  if (current) {
    const parent = path.dirname(current);
    try {
      for (const e of fs.readdirSync(parent, { withFileTypes: true }))
        if (e.isDirectory() && !e.name.startsWith(".")) add(path.join(parent, e.name));
    } catch {
      /* unreadable parent */
    }
  }
  return out;
}
