/**
 * The roster: every agent this process runs, as a tree.
 *
 * A **root** is what the user talks to (one per open conversation). A
 * **sub-agent** is created by any node with `spawn_subagent` and may create more.
 * The user can link roots as **siblings**. Who may message whom is decided here,
 * in code (`canReach`), never by a prompt:
 *
 *   a node reaches its parent and its children, its siblings (the other children
 *   of its parent; for a root, the roots it is linked to), and the siblings of
 *   each of its ancestors. Nothing else, and nothing in another tree.
 *
 * Everything an agent writes (a label, a task, a step, an answer, a message) is
 * model-authored: it is cleaned of control characters (a terminal would act on
 * them) and passed through `redact` before it is stored, shown or delivered.
 *
 * The interface reads a `RosterView` (snapshot, subscribe, no mutators). Only the
 * extensions and the fleet hold the `Roster` itself.
 */
import { redact } from "@mnemo/memory";

export type NodeKind = "root" | "sub";
export type Access = "read-only" | "full";
/** `idle` is for roots between prompts; a sub-agent is running until it ends. */
export type NodeStatus = "idle" | "running" | "done" | "failed" | "stopped";

export const LIMITS = {
  /** Deepest sub-agent (a root is 0). The deepest node cannot spawn. */
  maxDepth: 3,
  /** Live children one node may have. */
  maxChildren: 4,
  /** Live sub-agents under one root, at any depth. */
  maxLive: 16,
  /** Characters in one message. */
  messageChars: 2000,
  /** Messages one node may send per `rateWindowMs`. */
  sendsPerWindow: 30,
  rateWindowMs: 60_000,
  /** Messages a node may hold for its user's next prompt. */
  inbox: 20,
  /**
   * Messages in a row since a user last prompted: each message counts one more than
   * the message that led to it. Past this, messages wait for a user's next prompt, so
   * agents answering each other (and waking each other) cannot go on forever.
   */
  hops: 12,
  /**
   * Dollars an agent may spend on turns that messages started (and the sub-agents they
   * started) since its user last prompted. Past it a message no longer wakes the agent,
   * and a turn a message started is stopped: agents cannot run up a bill while you are away.
   */
  wakeSpend: 0.5,
  /**
   * Dollars one prompt may cost, its sub-agents and the turns messages start included, before
   * the run is stopped. 0 is no limit.
   */
  runSpend: 0,
  /** Model calls one prompt of a root may make before it is stopped. 0 is no limit. */
  maxTurns: 0,
  /** Model calls one sub-agent may make before it is stopped (it returns what it has). 0 is no limit. */
  subMaxTurns: 60,
  /** Dollars one sub-agent may spend before it is stopped. 0 is no limit. */
  subSpend: 0,
  /**
   * Ended sub-agents one conversation keeps in the live roster; older ones leave it (their
   * record stays in the session's state file), so a long session does not grow without end.
   */
  keepEnded: 40,
  /** Step lines and events kept. */
  steps: 20,
  events: 300,
} as const;

/** The numbers a roster enforces: `LIMITS` unless the user tuned them. */
export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

export interface RosterNode {
  id: number;
  kind: NodeKind;
  parent?: number;
  /** What it is called: the project for a root, a short name for a sub-agent. */
  label: string;
  /** A sub-agent's brief; a root's latest prompt. */
  task: string;
  depth: number;
  access: Access;
  status: NodeStatus;
  steps: string[];
  stepCount: number;
  answer?: string;
  /** For a root: the fleet agent it is. */
  agentId?: number;
  startedAt: number;
  endedAt?: number;
  /** Messages held for the user's next prompt (past `LIMITS.hops`). */
  pending: number;
  /** How many messages led here since a user last prompted (see `LIMITS.hops`). */
  hops: number;
  /** Its current or latest turn was started by a message, not by its user. */
  woken: boolean;
  /** Dollars spent on such turns since its user last prompted (see `LIMITS.wakeSpend`). */
  wakeSpend: number;
  /** Dollars spent since its user last prompted, whoever started the turn (see `LIMITS.runSpend`). */
  runSpend: number;
  /** Dollars this node's own model calls cost (a sub-agent's `subSpend` is held against it). */
  spent: number;
  /** Model calls this node made (a sub-agent's are held against `caps.turns`). */
  turns: number;
  /** For a sub-agent: the model it runs on (`provider/id`), its thinking level and its limits. */
  model?: string;
  thinking?: string;
  caps?: SubCaps;
  /** Where its transcript is saved, when its session is saved. */
  transcript?: string;
}

/** What one sub-agent may use. 0 for `turns` or `spend` is no limit. */
export interface SubCaps {
  turns: number;
  spend: number;
  /** Output tokens per model call. */
  maxTokens: number;
  /** Context it keeps before it compacts. */
  context: number;
}

/** `demo-model · 3/60 turns · $0.03`: what a sub-agent runs on and how much of its limits it used. */
export function usage(n: Pick<RosterNode, "model" | "turns" | "spent" | "caps">): string {
  if (!n.model) return "";
  const id = n.model.slice(n.model.indexOf("/") + 1);
  const turns = n.caps?.turns ? `${n.turns}/${n.caps.turns} turns` : `${n.turns} turn${n.turns === 1 ? "" : "s"}`;
  const spent = n.caps?.spend ? `$${n.spent.toFixed(2)}/$${n.caps.spend.toFixed(2)}` : `$${n.spent.toFixed(2)}`;
  return `${id} · ${turns} · ${spent}`;
}

export type RosterEvent =
  | { at: number; kind: "root" | "close"; node: number }
  | { at: number; kind: "spawn"; node: number; parent: number }
  | { at: number; kind: "done" | "failed" | "stopped"; node: number }
  | { at: number; kind: "message"; from: number; to: number; text: string; delivery: Delivery }
  | { at: number; kind: "link" | "unlink"; node: number; other?: number }
  | { at: number; kind: "told"; node: number; text: string }
  | { at: number; kind: "capped"; node: number; spent: number }
  | { at: number; kind: "budget"; node: number; spent: number };

export interface RosterSnapshot {
  version: number;
  nodes: readonly RosterNode[];
  /** Root id → link group, for roots that are linked. */
  groups: ReadonlyMap<number, number>;
  events: readonly RosterEvent[];
  /** Every node's name, including nodes that have left, for the event feed. */
  labels: ReadonlyMap<number, string>;
  /** What the roster enforces now (the user may have tuned it). */
  limits: Limits;
}

/** The interface's whole view of the roster: it can look and subscribe, nothing more. */
export interface RosterView {
  snapshot(): RosterSnapshot;
  subscribe(fn: () => void): () => void;
}

export interface PeerMessage {
  from: number;
  fromLabel: string;
  fromRole: string;
  text: string;
  at: number;
}

/** How a message reached its target: during its run, by starting a turn, or held for the user's next prompt. */
export type Delivery = "now" | "woken" | "held";

/** For a held message, why: the chain of messages is too long, or the agent spent its allowance. */
export type SendResult = { ok: true; delivery: Delivery; held?: "chain" | "spend" } | { ok: false; reason: string };

/** What a node's extension gives the roster so messages and stops can reach it. */
export interface NodeHandle {
  /**
   * Hand over a message: read during the current run (`now`), start a turn (`woken`), or wait
   * for the next prompt (`held`). True when the agent took it at once (a tool call was waiting for it).
   */
  deliver(message: PeerMessage, how: Delivery): boolean | void;
  /** The user's own words to a running sub-agent, read after its current step. */
  tell?(text: string): boolean;
  /** End the node's run (its root was closed, or its parent was stopped). */
  stop(): void;
}

export class RosterError extends Error {}

/** Control characters out (a terminal would obey them); newlines and tabs stay; length bounded. */
export function clean(text: unknown, max: number): string {
  const s = redact(String(text ?? ""))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

const ENDED: readonly NodeStatus[] = ["done", "failed", "stopped"];
export const isEnded = (s: NodeStatus): boolean => ENDED.includes(s);

export class Roster implements RosterView {
  private nodes = new Map<number, RosterNode>();
  private handles = new Map<number, NodeHandle>();
  private group = new Map<number, number>();
  private labels = new Map<number, string>();
  private events: RosterEvent[] = [];
  private sent = new Map<number, number[]>();
  private nextNode = 1;
  private nextGroup = 1;
  private version = 0;
  private snap: RosterSnapshot;
  private listeners = new Set<() => void>();

  constructor(
    private readonly now: () => number = Date.now,
    /** Mutable so the settings menu can change them while agents run; a lowered cap stops new work, it never ends work in progress. */
    public limits: Limits = { ...LIMITS },
  ) {
    this.snap = this.build();
  }

  setLimits(patch: Partial<Limits>): void {
    this.limits = { ...this.limits, ...patch };
    this.changed();
  }

  // ── reading ──────────────────────────────────────────────────────────────
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = (): RosterSnapshot => this.snap;
  get = (id: number): RosterNode | undefined => this.nodes.get(id);
  children = (id: number): RosterNode[] => [...this.nodes.values()].filter((n) => n.parent === id);
  roots = (): RosterNode[] => [...this.nodes.values()].filter((n) => n.kind === "root");

  /** The ancestors of `id`, parent first, root last. */
  ancestors(id: number): RosterNode[] {
    const out: RosterNode[] = [];
    for (let n = this.nodes.get(id); n?.parent !== undefined; ) {
      n = this.nodes.get(n.parent);
      if (!n) break;
      out.push(n);
    }
    return out;
  }

  rootOf(id: number): RosterNode | undefined {
    const n = this.nodes.get(id);
    return n?.kind === "root" ? n : this.ancestors(id).at(-1);
  }

  /** Every descendant of `id`. */
  descendants(id: number): RosterNode[] {
    const out: RosterNode[] = [];
    const walk = (p: number) => {
      for (const c of this.children(p)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  /** The nodes at the same level as `id`: for a sub-agent its parent's other children, for a root its linked roots. */
  siblings(id: number): RosterNode[] {
    const n = this.nodes.get(id);
    if (!n) return [];
    if (n.kind === "sub") return this.children(n.parent!).filter((c) => c.id !== id);
    const g = this.group.get(id);
    return g === undefined ? [] : this.roots().filter((r) => r.id !== id && this.group.get(r.id) === g);
  }

  /** Who `id` may talk to and look at. */
  family(id: number): RosterNode[] {
    const n = this.nodes.get(id);
    if (!n) return [];
    const out = new Map<number, RosterNode>();
    const add = (x: RosterNode | undefined) => {
      if (x && x.id !== id) out.set(x.id, x);
    };
    if (n.parent !== undefined) add(this.nodes.get(n.parent));
    for (const c of this.children(id)) add(c);
    for (const s of this.siblings(id)) add(s);
    for (const a of this.ancestors(id)) for (const s of this.siblings(a.id)) add(s);
    return [...out.values()];
  }

  canReach(from: number, to: number): boolean {
    return from !== to && this.family(from).some((n) => n.id === to);
  }

  /** The linked roots of `id` (itself not included), for the agents page. */
  linked(id: number): RosterNode[] {
    return this.siblings(id).filter((n) => n.kind === "root");
  }

  // ── roots ────────────────────────────────────────────────────────────────
  addRoot(label: string, handle?: NodeHandle, agentId?: number): RosterNode {
    const node = this.make({ kind: "root", label: clean(label, 60), task: "", depth: 0, access: "full", status: "idle", agentId });
    if (handle) this.handles.set(node.id, handle);
    this.event({ at: this.now(), kind: "root", node: node.id });
    return node;
  }

  /** A root's extension or the fleet fills these in once they exist. */
  attach(id: number, handle: NodeHandle): void {
    this.handles.set(id, handle);
  }

  describeRoot(id: number, o: { label?: string; agentId?: number }): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "root") return;
    if (o.label !== undefined) this.labels.set(id, (n.label = clean(o.label, 60)));
    if (o.agentId !== undefined) n.agentId = o.agentId;
    this.changed();
  }

  /** The root left the program: its tree is stopped and its links dropped. */
  removeRoot(id: number): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "root") return;
    this.unlink(id);
    for (const d of this.descendants(id).reverse()) this.drop(d, "stopped");
    this.nodes.delete(id);
    this.handles.delete(id);
    this.sent.delete(id);
    this.event({ at: this.now(), kind: "close", node: id });
  }

  // ── sub-agents ───────────────────────────────────────────────────────────
  /** Register a sub-agent of `parent`, or throw a `RosterError` the model can read. */
  addSub(parent: number, o: { label: string; task: string; access: Access; model?: string; thinking?: string; caps?: SubCaps }): RosterNode {
    const p = this.nodes.get(parent);
    if (!p) throw new RosterError("the agent that asked is no longer running");
    if (isEnded(p.status)) throw new RosterError("this agent has already finished");
    if (p.depth >= this.limits.maxDepth) throw new RosterError(`sub-agents nest at most ${this.limits.maxDepth} deep; do this one yourself`);
    if (p.access === "read-only" && o.access === "full") throw new RosterError("a read-only agent can only start read-only sub-agents");
    const live = this.children(parent).filter((c) => !isEnded(c.status)).length;
    if (live >= this.limits.maxChildren) throw new RosterError(`this agent already has ${live} sub-agents running (limit ${this.limits.maxChildren}); wait for one to finish`);
    const root = this.rootOf(parent)!;
    const total = this.descendants(root.id).filter((c) => !isEnded(c.status)).length;
    if (total >= this.limits.maxLive) throw new RosterError(`${total} sub-agents are already running under this conversation (limit ${this.limits.maxLive})`);
    const node = this.make({
      kind: "sub",
      parent,
      label: clean(o.label, 40) || `agent ${this.nextNode}`,
      task: clean(o.task, 400),
      depth: p.depth + 1,
      access: o.access,
      model: o.model,
      thinking: o.thinking,
      caps: o.caps,
      status: "running",
      // Started by a chain of messages, it continues that chain.
      hops: p.hops,
    });
    this.event({ at: this.now(), kind: "spawn", node: node.id, parent });
    return node;
  }

  /** A sub-agent ended. A sub-agent that is already ended keeps its first outcome. */
  finish(id: number, status: "done" | "failed" | "stopped", answer?: string): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "sub" || isEnded(n.status)) return;
    n.status = status;
    n.endedAt = this.now();
    n.pending = 0;
    this.sent.delete(id);
    if (answer !== undefined) n.answer = clean(answer, 1500);
    this.handles.delete(id);
    this.archive(id);
    this.event({ at: this.now(), kind: status, node: id });
  }

  /** Past `keepEnded` ended sub-agents under a root, the oldest whole ended subtrees leave the live roster. */
  private archive(id: number): void {
    const root = this.rootOf(id);
    if (!root) return;
    const all = this.descendants(root.id);
    let ended = all.filter((n) => isEnded(n.status)).length;
    const oldest = all.filter((n) => isEnded(n.status) && n.id !== id).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const n of oldest) {
      if (ended <= this.limits.keepEnded) break;
      if (!this.nodes.has(n.id)) continue;
      const tree = [n, ...this.descendants(n.id)];
      if (tree.some((d) => !isEnded(d.status))) continue;
      for (const d of tree) {
        this.nodes.delete(d.id);
        ended--;
      }
    }
  }

  setTranscript(id: number, file: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.transcript = file;
    this.changed();
  }

  setStatus(id: number, status: NodeStatus): void {
    const n = this.nodes.get(id);
    if (!n || isEnded(n.status) || n.status === status) return;
    n.status = status;
    this.changed();
  }

  /** The user prompted this node: it reads what was held for it, and what it sends now starts a new chain. */
  userTurn(id: number): void {
    const n = this.nodes.get(id);
    if (!n || (n.hops === 0 && n.pending === 0 && !n.woken && n.wakeSpend === 0 && n.runSpend === 0)) return;
    n.hops = 0;
    n.pending = 0;
    n.woken = false;
    n.wakeSpend = 0;
    n.runSpend = 0;
    this.changed();
  }

  /**
   * A model call of this node cost `usd`. It counts against its root's run budget, and against
   * its allowance when the root's turn was started by a message; the call that crosses either
   * stops that turn.
   */
  spend(id: number, usd: number): void {
    if (!(usd > 0)) return;
    const own = this.nodes.get(id);
    if (own) own.spent += usd;
    let root = this.nodes.get(id);
    while (root && root.parent !== undefined) root = this.nodes.get(root.parent);
    if (!root) return;
    const ran = root.runSpend;
    root.runSpend += usd;
    if (this.limits.runSpend > 0 && ran < this.limits.runSpend && root.runSpend >= this.limits.runSpend) {
      this.event({ at: this.now(), kind: "budget", node: root.id, spent: root.runSpend });
      if (root.status === "running") this.handles.get(root.id)?.stop();
    }
    if (!root.woken) return void this.changed();
    const before = root.wakeSpend;
    root.wakeSpend += usd;
    if (before < this.limits.wakeSpend && root.wakeSpend >= this.limits.wakeSpend) {
      this.event({ at: this.now(), kind: "capped", node: root.id, spent: root.wakeSpend });
      if (root.status === "running") this.handles.get(root.id)?.stop();
    }
    this.changed();
  }

  /** The user types to a running sub-agent: it reads it after its current step, as its user's words. */
  tell(id: number, text: string): { ok: true } | { ok: false; reason: string } {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "sub") return { ok: false, reason: "only a sub-agent is told things from its pane" };
    if (isEnded(n.status)) return { ok: false, reason: `${n.label} has finished; its answer went to its parent` };
    const body = clean(text, this.limits.messageChars * 2).trim();
    if (!body) return { ok: false, reason: "the message is empty" };
    if (!this.handles.get(id)?.tell?.(body)) return { ok: false, reason: `${n.label} cannot be reached right now` };
    // Its user spoke: what it sends from here starts a new chain.
    n.hops = 0;
    this.step(id, `✎ you: ${body.split("\n")[0]}`);
    this.event({ at: this.now(), kind: "told", node: id, text: body });
    return { ok: true };
  }

  /** The node made a model call. */
  turn(id: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.turns++;
    this.changed();
  }

  setTask(id: number, task: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.task = clean(task, 400);
    this.changed();
  }

  step(id: number, line: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.stepCount++;
    n.steps = [...n.steps, clean(line, 120)].slice(-LIMITS.steps);
    this.changed();
  }

  /** Stop a sub-agent and everything under it (its parent was stopped, or its root closed). */
  stopTree(id: number): void {
    for (const d of [...this.descendants(id).reverse(), this.nodes.get(id)]) if (d && d.kind === "sub") this.drop(d, "stopped");
  }

  private drop(n: RosterNode, status: "stopped"): void {
    const h = this.handles.get(n.id);
    if (!isEnded(n.status)) this.finish(n.id, status);
    try {
      h?.stop();
    } catch {
      /* already gone */
    }
  }

  // ── sibling links (the user's, from the agents page) ─────────────────────
  link(a: number, b: number): boolean {
    const x = this.nodes.get(a);
    const y = this.nodes.get(b);
    if (!x || !y || x.kind !== "root" || y.kind !== "root" || a === b) return false;
    const gx = this.group.get(a);
    const gy = this.group.get(b);
    if (gx !== undefined && gx === gy) return false;
    const g = gx ?? gy ?? this.nextGroup++;
    // Joining two groups merges them.
    for (const [r, v] of this.group) if (gy !== undefined && v === gy) this.group.set(r, g);
    this.group.set(a, g);
    this.group.set(b, g);
    this.event({ at: this.now(), kind: "link", node: a, other: b });
    return true;
  }

  /** Take `id` out of its group; a group of one is dissolved. */
  unlink(id: number): boolean {
    const g = this.group.get(id);
    if (g === undefined) return false;
    this.group.delete(id);
    const rest = [...this.group].filter(([, v]) => v === g).map(([r]) => r);
    if (rest.length === 1) this.group.delete(rest[0]!);
    this.event({ at: this.now(), kind: "unlink", node: id });
    return true;
  }

  groupOf = (id: number): number | undefined => this.group.get(id);

  // ── messages ─────────────────────────────────────────────────────────────
  send(from: number, to: number, text: string): SendResult {
    const sender = this.nodes.get(from);
    const target = this.nodes.get(to);
    if (!sender || isEnded(sender.status)) return { ok: false, reason: "you are no longer running" };
    // One answer for "does not exist" and "not yours to reach", so ids in other trees cannot be probed.
    if (!target || !this.canReach(from, to)) return { ok: false, reason: `agent #${to} is not in your family; list_agents shows who you can message` };
    if (isEnded(target.status)) return { ok: false, reason: `agent #${to} has finished` };
    const body = clean(text, this.limits.messageChars + 1);
    if (!body.trim()) return { ok: false, reason: "the message is empty" };
    if (body.length > this.limits.messageChars) return { ok: false, reason: `the message is over ${this.limits.messageChars} characters; say it shorter` };
    const t = this.now();
    const recent = (this.sent.get(from) ?? []).filter((x) => t - x < LIMITS.rateWindowMs);
    if (recent.length >= this.limits.sendsPerWindow) return { ok: false, reason: "you are sending too fast; wait a minute" };
    const handle = this.handles.get(to);
    if (!handle) return { ok: false, reason: `agent #${to} cannot receive messages right now` };
    const hop = sender.hops + 1;
    const spent = target.wakeSpend >= this.limits.wakeSpend;
    const delivery: Delivery = hop > this.limits.hops || (spent && target.status !== "running") ? "held" : target.status === "running" ? "now" : "woken";
    if (delivery === "held") {
      const over = `the agents have exchanged ${this.limits.hops} messages since a user last spoke`;
      // A sub-agent has no user and no next prompt: a message held for it would never be read.
      if (target.kind === "sub") return { ok: false, reason: `${over}; stop messaging and report to your user` };
      if (target.pending >= this.limits.inbox) return { ok: false, reason: `agent #${to} already has ${target.pending} messages waiting for its user` };
      target.pending++;
    } else if (delivery === "woken") {
      // A woken turn is its own link in the chain; a running agent keeps the longest chain it is in.
      target.hops = hop;
      target.woken = true;
    } else {
      target.hops = Math.max(target.hops, hop);
    }
    this.sent.set(from, [...recent, t]);
    const taken = handle.deliver({ from, fromLabel: sender.label, fromRole: sender.kind === "root" ? "top-level agent" : `sub-agent (depth ${sender.depth})`, text: body, at: t }, delivery);
    if (taken && delivery === "held") target.pending--;
    this.event({ at: t, kind: "message", from, to, text: body, delivery });
    return delivery === "held" ? { ok: true, delivery, held: hop > this.limits.hops ? "chain" : "spend" } : { ok: true, delivery };
  }

  // ── internals ────────────────────────────────────────────────────────────
  private make(o: Pick<RosterNode, "kind" | "label" | "task" | "depth" | "access" | "status"> & Partial<RosterNode>): RosterNode {
    const node: RosterNode = { steps: [], stepCount: 0, startedAt: this.now(), pending: 0, hops: 0, woken: false, wakeSpend: 0, runSpend: 0, spent: 0, turns: 0, ...o, id: this.nextNode++ };
    this.nodes.set(node.id, node);
    this.labels.set(node.id, node.label);
    return node;
  }

  private event(e: RosterEvent): void {
    this.events = [...this.events, e].slice(-LIMITS.events);
    this.changed();
  }

  private build(): RosterSnapshot {
    return {
      version: this.version,
      nodes: [...this.nodes.values()].map((n) => ({ ...n, steps: [...n.steps], caps: n.caps && { ...n.caps } })),
      groups: new Map(this.group),
      events: this.events,
      labels: new Map(this.labels),
      limits: this.limits,
    };
  }

  private changed(): void {
    this.version++;
    this.snap = this.build();
    for (const fn of this.listeners) fn();
  }
}

/** The tree for display: roots in order, each with its descendants depth-first. */
export function forest(snap: Pick<RosterSnapshot, "nodes">): { node: RosterNode; depth: number; last: boolean }[] {
  const out: { node: RosterNode; depth: number; last: boolean }[] = [];
  const kids = (id: number) => snap.nodes.filter((n) => n.parent === id);
  const walk = (n: RosterNode, depth: number, last: boolean) => {
    out.push({ node: n, depth, last });
    const cs = kids(n.id);
    cs.forEach((c, i) => walk(c, depth + 1, i === cs.length - 1));
  };
  const roots = snap.nodes.filter((n) => n.kind === "root");
  roots.forEach((r, i) => walk(r, 0, i === roots.length - 1));
  return out;
}
