/**
 * One call puts a process in the registry: its record (publisher.ts) and its inbox (inbox.ts),
 * fed by the conversations it runs. Joining never stops Mnemo from starting: a home that cannot
 * be written to means the other terminals do not see this one, nothing more.
 * `MNEMO_REGISTRY=0` keeps a process out entirely.
 */
import * as path from "node:path";
import type { Controller } from "../runtime/controller.ts";
import type { Roster } from "../runtime/roster.ts";
import { controls, type RootControl } from "./controls.ts";
import { Inbox } from "./inbox.ts";
import { Publisher } from "./publisher.ts";
import { prune, type ProcKind } from "./store.ts";

/** A conversation this process runs. */
export interface Member {
  node: number;
  cwd: string;
  model?(): string | undefined;
  mode?(): string | undefined;
  waiting?(): string | undefined;
  session?(): string | undefined;
  control: RootControl;
}

export interface Joined {
  tag: string;
  publisher: Publisher;
  inbox: Inbox;
  /** Write the record now (something the roster does not see changed: a dialog, a model). */
  poke(): void;
  close(): void;
}

/** A conversation driven by a controller: a terminal's, or `--rpc`'s. */
export function memberOf(node: number, cwd: string, c: Controller): Member {
  const s = () => c.runtime.session;
  return {
    node,
    cwd,
    model: () => (s().model ? `${s().model!.provider}/${s().model!.id}` : undefined),
    mode: () => c.mode,
    waiting: () => {
      const d = c.dialogs.current();
      return d ? (d.kind === "approval" ? `approve ${d.request.tool}` : "an answer") : undefined;
    },
    session: () => s().sessionFile,
    control: {
      running: () => s().isStreaming,
      submit: (text, how) => void c.submit(text, how === "steer" ? "steer" : "auto"),
      notice: (text) => c.transcript.notice(text),
      interrupt: () => c.interrupt(),
    },
  };
}

export function joinRegistry(o: { home: string; kind: ProcKind; version: string; roster: Roster; members: () => Member[]; env?: Record<string, string | undefined> }): Joined | undefined {
  if ((o.env ?? process.env).MNEMO_REGISTRY === "0") return undefined;
  try {
    prune(o.home);
    const member = (node: number) => {
      const root = o.roster.get(node)?.kind === "root" ? o.roster.get(node) : o.roster.rootOf(node);
      return root && o.members().find((m) => m.node === root.id);
    };
    const publisher = new Publisher({
      home: o.home,
      kind: o.kind,
      version: o.version,
      roster: o.roster,
      describe: (n) => {
        const m = member(n.id);
        if (!m) return {};
        return { cwd: m.cwd, model: m.model?.(), ...(n.kind === "root" ? { mode: m.mode?.(), waiting: m.waiting?.(), session: m.session?.() } : {}) };
      },
    }).start();
    const inbox = new Inbox(o.home, publisher.tag, controls(o.roster, (node) => o.members().find((m) => m.node === node)?.control)).start();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      inbox.stop();
      publisher.close();
    };
    // A quit that skips the normal path (process.exit from a command) still says it ended.
    process.once("exit", close);
    return { tag: publisher.tag, publisher, inbox, poke: () => publisher.soon(), close };
  } catch {
    return undefined;
  }
}

/** The name a request is signed with: the folder it was sent from. */
export const senderName = (cwd: string) => path.basename(cwd) || cwd;
