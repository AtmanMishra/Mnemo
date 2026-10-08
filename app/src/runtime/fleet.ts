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

export interface FleetSnapshot {
  agents: readonly Agent[];
  /** Folders opened before, most recent first. */
  recent: readonly string[];
}

const RECENT_MAX = 20;

export class Fleet {
  private agents: Agent[] = [];
  private recent: string[];
  private nextId = 1;
  private listeners = new Set<() => void>();
  private snap: FleetSnapshot;

  constructor(
    private readonly spawn: Spawn,
    private readonly o: {
      /** Called when the last agent has closed. */
      onEmpty: (code: number) => void;
      recent?: string[];
      /** Persist the recent list (state.json). */
      saveRecent?: (recent: string[]) => void;
    },
  ) {
    this.recent = (o.recent ?? []).slice(0, RECENT_MAX);
    this.snap = { agents: [], recent: this.recent };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): FleetSnapshot => this.snap;

  private changed(): void {
    this.snap = { agents: [...this.agents], recent: [...this.recent] };
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

  /** The exit callback each controller was given. */
  closed(id: number, code = 0): void {
    const before = this.agents.length;
    this.agents = this.agents.filter((a) => a.id !== id);
    if (this.agents.length === before) return;
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
export function projectCandidates(snap: FleetSnapshot, current: string | undefined): string[] {
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
