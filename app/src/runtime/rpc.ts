/**
 * `mnemo --rpc`: the controller over JSON lines, for an editor or any other front end.
 *
 * Standard input carries commands, standard output carries events, one JSON object a
 * line (protocol 1; docs/RPC.md). Nothing here decides anything the terminal interface
 * does not: a tool call that would ask becomes a `dialog` event with the same request the
 * terminal shows, and runs only if the client sends an `answer`. There is no option that
 * answers for the client, and a client that goes away leaves every dialog unanswered
 * (the process exits and they resolve as "no").
 */
import { projectIdentity } from "@mnemo/memory";
import type { Controller } from "./controller.ts";
import type { Dialog } from "./dialogs.ts";
import type { Mode } from "../extensions/host.ts";
import { DEFS, GROUPS, isKey } from "./settings.ts";
import type { RosterNode } from "./roster.ts";

export const PROTOCOL = 1;

const MODES: readonly Mode[] = ["default", "accept-edits", "plan", "yolo"];

export interface RpcOptions {
  controller: Controller;
  version: string;
  /** One event out. The server never writes anywhere else. */
  write: (event: Record<string, unknown>) => void;
  /** Called by `quit`; the caller ends the process. */
  onQuit: () => void;
  /** Coalescing delay for streamed state, ms (tests pass 0). */
  flushMs?: number;
}

/** A dialog without its resolver, for the wire. */
export function wireDialog(d: Dialog): Record<string, unknown> {
  switch (d.kind) {
    case "approval":
      return { id: d.id, kind: "approval", ...d.request };
    case "select":
      return { id: d.id, kind: "select", title: d.title, choices: d.choices, initial: d.initial };
    case "confirm":
      return { id: d.id, kind: "confirm", title: d.title, message: d.message };
    case "text":
      return { id: d.id, kind: "text", title: d.title, placeholder: d.placeholder, initial: d.initial, secret: d.secret };
  }
}

function wireNode(n: RosterNode) {
  return {
    id: n.id,
    kind: n.kind,
    parent: n.parent,
    label: n.label,
    task: n.task,
    access: n.access,
    status: n.status,
    steps: n.steps.slice(-5),
    stepCount: n.stepCount,
    answer: n.answer,
    startedAt: n.startedAt,
    endedAt: n.endedAt,
    woken: n.woken,
    wakeSpend: n.wakeSpend,
    model: n.model,
    turns: n.turns,
    spent: n.spent,
    caps: n.caps,
  };
}

export class RpcServer {
  private readonly c: Controller;
  private unsubscribe: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sentCommitted = 0;
  private sentEpoch = -1;
  private open = new Set<number>();
  private lastSent = new Map<string, string>();

  constructor(private readonly o: RpcOptions) {
    this.c = o.controller;
  }

  start(): void {
    const c = this.c;
    const schedule = () => {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.o.flushMs ?? 30);
    };
    this.unsubscribe.push(c.transcript.subscribe(schedule), c.subscribe(schedule), c.dialogs.subscribe(schedule));
    const host = c.host;
    if (host) this.unsubscribe.push(host.roster.subscribe(schedule), host.settings.subscribe(schedule));
    this.o.write({ type: "ready", protocol: PROTOCOL, version: this.o.version, cwd: c.runtime.cwd, hasModel: c.hasModel, commands: c.commands() });
    this.flush(true);
  }

  stop(): void {
    for (const u of this.unsubscribe.splice(0)) u();
    if (this.timer) clearTimeout(this.timer);
  }

  /** Send a state event only when it differs from the last one of its type. */
  private state(event: { type: string } & Record<string, unknown>): void {
    const text = JSON.stringify(event);
    if (this.lastSent.get(event.type) === text) return;
    this.lastSent.set(event.type, text);
    this.o.write(event);
  }

  /** What changed since the last flush, as events. `all` resends the slow state too. */
  private flush(all = false): void {
    const t = this.c.transcript.snapshot();
    const reset = t.epoch !== this.sentEpoch || t.committed.length < this.sentCommitted;
    if (reset) this.sentCommitted = 0;
    const changed = reset || t.committed.length > this.sentCommitted || JSON.stringify([t.live, t.working, t.queue]) !== this.lastSent.get("transcript");
    this.lastSent.set("transcript", JSON.stringify([t.live, t.working, t.queue]));
    if (changed)
      this.o.write({
      type: "transcript",
      reset,
      epoch: t.epoch,
      from: this.sentCommitted,
      committed: t.committed.slice(this.sentCommitted),
      live: t.live,
      working: t.working,
      queue: t.queue,
    });
    this.sentCommitted = t.committed.length;
    this.sentEpoch = t.epoch;

    const chrome = this.c.snapshot();
    this.state({ type: "chrome", footer: chrome.footer, statuses: chrome.statuses, workingMessage: chrome.workingMessage, race: chrome.race, activity: chrome.activity, draft: chrome.draftRequest });

    const current = new Set([this.c.dialogs.current()].filter((d): d is Dialog => !!d).map((d) => d.id));
    for (const id of this.open) if (!current.has(id)) this.o.write({ type: "dialogClosed", id });
    const dialog = this.c.dialogs.current();
    if (dialog && !this.open.has(dialog.id)) this.o.write({ type: "dialog", dialog: wireDialog(dialog) });
    this.open = current;

    const host = this.c.host;
    if (host) {
      const snap = host.roster.snapshot();
      this.state({ type: "roster", nodes: snap.nodes.map(wireNode), self: host.node, limits: snap.limits });
      this.state({ type: "settings", values: host.settings.get(), ...(all ? { defs: this.defs() } : {}) });
    }
  }

  private defs() {
    return { groups: GROUPS, items: Object.entries(DEFS).map(([key, d]) => ({ key, ...d })) };
  }

  /** One input line. Never throws: a bad line is an `error` event. */
  async handle(line: string): Promise<void> {
    if (!line.trim()) return;
    let msg: { type?: unknown; id?: unknown; [k: string]: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return void this.o.write({ type: "error", message: "not JSON" });
    }
    const reply = (ok: boolean, value?: unknown, error?: string) => {
      if (msg.id !== undefined) this.o.write({ type: "result", id: msg.id, ok, value, error });
      // A refusal nobody asked an answer for (a settings field typed wrong) must not vanish.
      else if (!ok && error) this.o.write({ type: "error", message: error });
    };
    try {
      switch (msg.type) {
        case "submit":
          if (typeof msg.text !== "string") return reply(false, undefined, "submit needs text");
          // Not awaited: a turn runs for minutes, and answers must still be read meanwhile.
          void this.c.submit(msg.text, msg.steer === true ? "steer" : "auto").then(() => reply(true));
          return;
        case "interrupt":
          this.c.interrupt();
          return reply(true);
        case "answer":
          return reply(this.answer(msg));
        case "setMode":
          if (!MODES.includes(msg.mode as Mode)) return reply(false, undefined, `mode is one of ${MODES.join(", ")}`);
          this.c.setMode(msg.mode as Mode);
          return reply(true);
        case "cycleThinking":
          this.c.cycleThinking();
          return reply(true);
        case "setSetting": {
          if (typeof msg.key !== "string" || !isKey(msg.key)) return reply(false, undefined, "unknown setting");
          const r = this.c.settings.set(msg.key, msg.value);
          return r.ok ? reply(true) : reply(false, undefined, r.error);
        }
        case "resetSetting": {
          if (msg.key !== undefined && (typeof msg.key !== "string" || !isKey(msg.key))) return reply(false, undefined, "unknown setting");
          this.c.settings.reset(msg.key as never);
          return reply(true);
        }
        case "memory":
          return reply(true, await this.memory(typeof msg.query === "string" ? msg.query : ""));
        case "quit":
          reply(true);
          this.o.onQuit();
          return;
        default:
          return reply(false, undefined, `unknown command ${String(msg.type)}`);
      }
    } catch (e) {
      reply(false, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  /** Resolve the dialog on screen. Only the oldest one can be answered, as in the terminal. */
  private answer(msg: { id?: unknown; [k: string]: unknown }): boolean {
    const d = this.c.dialogs.current();
    if (!d || d.id !== msg.id) return false;
    switch (d.kind) {
      case "approval": {
        const a = msg.answer as { kind?: string; feedback?: unknown } | undefined;
        if (a?.kind === "yes") d.resolve({ kind: "yes" });
        else if (a?.kind === "always" && d.request.always) d.resolve({ kind: "always" });
        else d.resolve({ kind: "no", feedback: typeof a?.feedback === "string" ? a.feedback.slice(0, 500) : undefined });
        return true;
      }
      case "confirm":
        d.resolve(msg.ok === true);
        return true;
      case "select":
        d.resolve(typeof msg.value === "string" && d.choices.some((c) => c.value === msg.value) ? msg.value : undefined);
        return true;
      case "text":
        d.resolve(typeof msg.value === "string" ? msg.value : undefined);
        return true;
    }
  }

  private async memory(query: string) {
    const mem = this.c.host?.memory;
    if (!mem) return { available: false };
    const id = projectIdentity(this.c.runtime.cwd).id;
    const [project, user, hits] = await Promise.all([mem.profile("project", id), mem.profile("user", id), query ? mem.search(query, 8) : Promise.resolve([])]);
    return { available: true, project, user, hits };
  }
}
