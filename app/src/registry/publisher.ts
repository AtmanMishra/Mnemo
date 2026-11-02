/**
 * This process's entry in the registry (store.ts): its roster, written to `procs/<tag>.json`
 * when the roster changes (at most every `throttleMs`) and every `HEARTBEAT_MS` as a heartbeat,
 * and marked ended when the process quits.
 *
 * It only reads the roster. A conversation that closed leaves the roster; it stays here as
 * `closed`, with the last thing it was doing, so the other terminals see it finished.
 */
import type { RosterNode, RosterView } from "../runtime/roster.ts";
import { isEnded } from "../runtime/roster.ts";
import { claimTag, HEARTBEAT_MS, procFile, writeJson, type AgentEntry, type ProcKind, type ProcRecord } from "./store.ts";

/** What the roster does not know about a node: its folder, model, mode, transcript, an open question. */
export type Describe = (node: RosterNode) => Partial<Pick<AgentEntry, "cwd" | "model" | "mode" | "waiting" | "session">>;

export interface PublisherOptions {
  home: string;
  kind: ProcKind;
  version: string;
  roster: RosterView;
  describe?: Describe;
  now?: () => number;
  throttleMs?: number;
  heartbeatMs?: number;
}

/** Agents kept per record: the live ones always, then the most recently ended. */
const MAX_AGENTS = 60;
const STEPS = 5;

export class Publisher {
  readonly tag: string;
  private readonly startedAt: number;
  private gone = new Map<number, AgentEntry>();
  private last = new Map<number, AgentEntry>();
  private timer?: ReturnType<typeof setTimeout>;
  private beat?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private endedAt?: number;
  private readonly now: () => number;

  constructor(private readonly o: PublisherOptions) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    this.tag = claimTag(o.home, (tag) => JSON.stringify(this.record(tag)));
  }

  /** Follow the roster and beat; until then only `flush` writes. */
  start(): this {
    this.unsubscribe = this.o.roster.subscribe(() => this.soon());
    this.beat = setInterval(() => this.flush(), this.o.heartbeatMs ?? HEARTBEAT_MS);
    this.beat.unref?.();
    this.flush();
    return this;
  }

  /** Write within `throttleMs`, so a burst of steps is one write. */
  soon(): void {
    if (this.timer || this.endedAt !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.o.throttleMs ?? 500);
    this.timer.unref?.();
  }

  flush(): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return writeJson(procFile(this.o.home, this.tag), this.record(this.tag));
  }

  /** The process is quitting: its agents are finished, and the record says it ended cleanly. */
  close(): void {
    if (this.endedAt !== undefined) return;
    this.unsubscribe?.();
    if (this.beat) clearInterval(this.beat);
    this.endedAt = this.now();
    this.flush();
  }

  record(tag: string): ProcRecord {
    const t = this.now();
    const nodes = this.o.roster.snapshot().nodes;
    const seen = new Set<number>();
    const agents: AgentEntry[] = [];
    for (const n of nodes) {
      seen.add(n.id);
      const e = this.entry(n);
      this.last.set(n.id, e);
      agents.push(e);
    }
    // A node that left the roster (its conversation closed) is shown as it was last seen, finished.
    for (const [id, e] of this.last)
      if (!seen.has(id)) {
        this.last.delete(id);
        this.gone.set(id, { ...e, status: e.status === "idle" || e.status === "running" ? (e.kind === "root" ? "closed" : "stopped") : e.status, endedAt: e.endedAt ?? t, waiting: undefined });
      }
    agents.push(...this.gone.values());
    if (this.endedAt !== undefined)
      for (const a of agents)
        if (a.status === "idle" || a.status === "running") Object.assign(a, { status: a.kind === "root" ? "closed" : "stopped", endedAt: a.endedAt ?? this.endedAt, waiting: undefined });
    const ended = (a: AgentEntry) => a.status !== "idle" && a.status !== "running";
    const keep = agents.filter((a) => !ended(a)).length;
    const trimmed = [...agents.filter((a) => !ended(a)), ...agents.filter(ended).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.node - a.node).slice(0, Math.max(0, MAX_AGENTS - keep))];
    // What was trimmed is not kept for the next write either.
    for (const id of [...this.gone.keys()]) if (!trimmed.includes(this.gone.get(id)!)) this.gone.delete(id);
    return { v: 1, tag, pid: process.pid, kind: this.o.kind, version: this.o.version, startedAt: this.startedAt, heartbeat: t, endedAt: this.endedAt, agents: trimmed.sort((a, b) => a.node - b.node) };
  }

  private entry(n: RosterNode): AgentEntry {
    let extra: ReturnType<Describe> = {};
    try {
      extra = this.o.describe?.(n) ?? {};
    } catch {
      /* the agent is closing: what the roster knows is enough */
    }
    return {
      node: n.id,
      parent: n.parent,
      kind: n.kind,
      label: n.label,
      task: n.task,
      depth: n.depth,
      access: n.access,
      status: n.status,
      ...extra,
      // A sub-agent may run on its own model; the roster knows which.
      model: n.model ?? extra.model,
      thinking: n.thinking,
      caps: n.caps,
      turns: n.turns,
      waiting: isEnded(n.status) ? undefined : extra.waiting,
      steps: n.steps.slice(-STEPS),
      stepCount: n.stepCount,
      answer: n.answer,
      startedAt: n.startedAt,
      endedAt: n.endedAt,
      spent: n.spent,
      pending: n.pending,
    };
  }
}
