/**
 * How this process carries out a request from another terminal (inbox.ts), through the calls
 * its own interface makes: the roster's `tell` and `stopTree` for a sub-agent, the
 * controller's `submit` and `interrupt` for a conversation. Nothing here answers an approval or
 * changes a mode, and words that look like a command are refused rather than run.
 */
import { clean, isEnded, type Roster } from "../runtime/roster.ts";
import type { Apply, Request } from "./inbox.ts";
import { TEXT_CHARS } from "./inbox.ts";

/** What a conversation (a root) offers: a controller in a terminal or `--rpc`, only a stop in `-p`. */
export interface RootControl {
  running(): boolean;
  /** The user's words: queued behind a running turn (`followUp`), read after its current step (`steer`), or a new turn. */
  submit?(text: string, how: "followUp" | "steer"): void;
  notice?(text: string): void;
  interrupt(): void;
}

export function controls(roster: Roster, rootControl: (node: number) => RootControl | undefined): Apply {
  return (req: Request) => {
    const n = roster.get(req.node);
    // Ids are per process; one that is not here is not an agent this process runs.
    if (!n) return { ok: false, result: `there is no agent ${req.node} in that process` };
    const from = req.from ? ` (from ${clean(req.from, 60)})` : "";
    if (n.kind === "sub") {
      if (isEnded(n.status)) return { ok: false, result: `${n.label} has finished` };
      if (req.op === "stop") {
        roster.stopTree(n.id);
        return { ok: true, result: `stopped ${n.label} and anything it started` };
      }
      const r = roster.tell(n.id, req.text ?? "");
      return r.ok ? { ok: true, result: `${n.label} reads it after its current step` } : { ok: false, result: r.reason };
    }
    const c = rootControl(n.id);
    if (!c) return { ok: false, result: `${n.label} cannot be reached right now` };
    if (req.op === "stop") {
      if (!c.running()) return { ok: false, result: `${n.label} is not working on anything` };
      c.interrupt();
      c.notice?.(`Stopped from another terminal${from}`);
      return { ok: true, result: `stopped ${n.label}'s turn` };
    }
    if (!c.submit) return { ok: false, result: `${n.label} is a headless run (mnemo -p); it takes no new words, only stop` };
    const text = clean(req.text ?? "", TEXT_CHARS).trim();
    if (!text) return { ok: false, result: "the message is empty" };
    // A slash command changes how that terminal works (its mode, its model): it is typed there, never sent.
    if (text.startsWith("/")) return { ok: false, result: "a command (/…) is typed in that agent's own terminal" };
    const running = c.running();
    c.notice?.(`${req.op === "steer" && running ? "Steered" : "Sent"} from another terminal${from}`);
    c.submit(text, req.op === "steer" ? "steer" : "followUp");
    if (!running) return { ok: true, result: `${n.label} started a turn with it` };
    return { ok: true, result: req.op === "steer" ? `${n.label} reads it after its current step` : `${n.label} reads it when its current turn ends` };
  };
}
