/**
 * Requests to a running Mnemo from another terminal, as files: `mnemo agents tell|steer|stop`
 * writes one into `inbox/<tag>/`, the owning process picks it up within about a second, applies
 * it through the same calls its own interface uses, and writes the answer to `acks/<id>.json`.
 * No socket is opened and nothing leaves the machine.
 *
 * What a request can do is small on purpose: give an agent the user's words (`tell` queues
 * them behind a running turn or starts one, `steer` has a running agent read them after its
 * current step) or stop it. It cannot answer an approval, change a mode, link agents or run a
 * command: approvals are answered only in the terminal that asked, and the words start a turn
 * under that terminal's mode and permission gate like anything typed there.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { acksDir, ensureDir, inboxDir, readJson, writeJson } from "./store.ts";

export type Op = "tell" | "steer" | "stop";
export const OPS: readonly Op[] = ["tell", "steer", "stop"];

export interface Request {
  v: 1;
  id: string;
  op: Op;
  node: number;
  text?: string;
  at: number;
  /** Where it was sent from, for the notice in the receiving terminal (a folder name). */
  from?: string;
}

export interface Ack {
  id: string;
  ok: boolean;
  result: string;
  at: number;
}

/** How the owning process carries a request out (registry/controls.ts). */
export type Apply = (req: Request) => Promise<{ ok: boolean; result: string }> | { ok: boolean; result: string };

/** A request over this size is not one. */
const MAX_BYTES = 16_384;
export const TEXT_CHARS = 8_000;
/** Requests applied per pickup, so a flood cannot stall the process. */
const PER_TICK = 20;
const NAME = /^\d{13}-[a-z0-9]{6,12}\.json$/;

const newId = (now: number) => `${now}-${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;

export function parseRequest(raw: unknown, id: string): Request | undefined {
  const r = raw as Partial<Request> | undefined;
  if (!r || r.v !== 1 || r.id !== id || !OPS.includes(r.op as Op) || typeof r.node !== "number" || !Number.isInteger(r.node) || r.node < 1) return undefined;
  if (r.text !== undefined && typeof r.text !== "string") return undefined;
  if ((r.op === "tell" || r.op === "steer") && !r.text?.trim()) return undefined;
  return { v: 1, id, op: r.op as Op, node: r.node, text: r.text?.slice(0, TEXT_CHARS), at: typeof r.at === "number" ? r.at : 0, from: typeof r.from === "string" ? r.from.slice(0, 80) : undefined };
}

/** Drop a request into a process's inbox. Returns its id, to wait for the answer with `awaitAck`. */
export function sendRequest(home: string, tag: string, o: { op: Op; node: number; text?: string; from?: string }, now = Date.now()): string {
  const id = newId(now);
  const req: Request = { v: 1, id, op: o.op, node: o.node, text: o.text, at: now, from: o.from };
  if (!writeJson(path.join(inboxDir(home, tag), `${id}.json`), req)) throw new Error(`could not write to ${inboxDir(home, tag)}`);
  return id;
}

/** The owner's answer, once it is there (and then it is removed); undefined after `timeoutMs`. */
export async function awaitAck(home: string, id: string, timeoutMs: number, pollMs = 100): Promise<Ack | undefined> {
  const file = path.join(acksDir(home), `${id}.json`);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const raw = readJson(file) as Partial<Ack> | undefined;
    if (raw && raw.id === id && typeof raw.ok === "boolean") {
      fs.rmSync(file, { force: true });
      return { id, ok: raw.ok, result: String(raw.result ?? ""), at: Number(raw.at) || 0 };
    }
    if (Date.now() >= until) return undefined;
    await Bun.sleep(pollMs);
  }
}

/** The owning side: reads its inbox every `pollMs` and answers each request once. */
export class Inbox {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly dir: string;

  constructor(
    private readonly home: string,
    readonly tag: string,
    private readonly apply: Apply,
    private readonly o: { pollMs?: number; now?: () => number } = {},
  ) {
    this.dir = inboxDir(home, tag);
  }

  start(): this {
    ensureDir(this.dir);
    this.timer = setInterval(() => void this.tick(), this.o.pollMs ?? 1000);
    this.timer.unref?.();
    return this;
  }

  /** Stop reading, and remove the inbox: nothing should wait on a process that is gone. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** One pickup; the number of requests answered. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      let names: string[];
      try {
        names = fs.readdirSync(this.dir).filter((n) => NAME.test(n)).sort();
      } catch {
        return 0;
      }
      let n = 0;
      for (const name of names.slice(0, PER_TICK)) {
        const file = path.join(this.dir, name);
        const id = name.slice(0, -5);
        const st = fs.statSync(file, { throwIfNoEntry: false });
        const raw = st && st.size <= MAX_BYTES ? readJson(file) : undefined;
        // Taken before it is applied: a request is carried out at most once, even if this process then dies.
        try {
          fs.rmSync(file);
        } catch {
          continue;
        }
        const req = parseRequest(raw, id);
        let ack: { ok: boolean; result: string };
        if (!req) ack = { ok: false, result: "not a request this version of Mnemo understands" };
        else
          try {
            ack = await this.apply(req);
          } catch (e) {
            ack = { ok: false, result: e instanceof Error ? e.message : String(e) };
          }
        writeJson(path.join(acksDir(this.home), `${id}.json`), { id, ok: ack.ok, result: ack.result, at: (this.o.now ?? Date.now)() } satisfies Ack);
        n++;
      }
      return n;
    } finally {
      this.busy = false;
    }
  }
}
