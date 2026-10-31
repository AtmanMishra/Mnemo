/**
 * Every saved conversation on this machine, in every project, and whether it is open somewhere,
 * was cut off when its process died, or is simply saved: pi's session files (one per
 * conversation, whatever folder it ran in) read against the registry's records (store.ts).
 * `mnemo agents saved` lists them and `mnemo agents resume` continues one from any folder.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { shownStatus, type ProcView } from "./store.ts";

/** What pi's `SessionManager.listAll` says about a session file, as much as this needs. */
export interface SessionLike {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  created: Date;
  modified: Date;
}

export type SavedState = "open" | "interrupted" | "saved";

export interface Saved {
  id: string;
  file: string;
  cwd: string;
  title: string;
  created: number;
  modified: number;
  state: SavedState;
  /** The registry's ref for it while it is open or was cut off (`k3f9.1`). */
  ref?: string;
  /** Its sub-agents' saved transcripts (kept beside it since sub-agents were saved). */
  subs: number;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Sub-agent transcripts beside a session: `<session>/sub/*.jsonl`. */
export function subTranscripts(file: string): string[] {
  const dir = path.join(file.replace(/\.jsonl$/, ""), "sub");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Each session, newest first, with where it stands. A session in two records counts the newest one. */
export function classify(sessions: SessionLike[], views: ProcView[]): Saved[] {
  const where = new Map<string, { state: SavedState; ref: string }>();
  // readAll is newest first: the first record naming a file wins.
  for (const v of views)
    for (const a of v.rec.agents) {
      if (a.kind !== "root" || !a.session || where.has(a.session)) continue;
      const status = shownStatus(a, v.state);
      const ref = `${v.rec.tag}.${a.node}`;
      if (v.state === "live" && (status === "idle" || status === "running")) where.set(a.session, { state: "open", ref });
      else if (status === "lost") where.set(a.session, { state: "interrupted", ref });
      else where.set(a.session, { state: "saved", ref });
    }
  return sessions
    .map((s) => {
      const w = where.get(s.path);
      return {
        id: s.id,
        file: s.path,
        cwd: s.cwd,
        title: oneLine(s.name || s.firstMessage || "(no messages)"),
        created: s.created.getTime(),
        modified: s.modified.getTime(),
        state: w?.state ?? "saved",
        ref: w && w.state !== "saved" ? w.ref : undefined,
        subs: subTranscripts(s.path).length,
      };
    })
    .sort((a, b) => b.modified - a.modified);
}

/**
 * Which saved conversation `ref` names: a registry ref (`k3f9.2`; a sub-agent's leads to the
 * conversation that started it), or the start of a session id (`019a3f`). A message when none
 * or several match.
 */
export function findSaved(saved: Saved[], views: ProcView[], ref: string): Saved | string {
  const r = ref.trim().toLowerCase();
  const m = /^([a-z0-9]{4,12})(?:\.(\d+))?$/.exec(r);
  if (m) {
    const view = views.find((v) => v.rec.tag === m[1]);
    if (view) {
      let a = m[2] === undefined ? view.rec.agents.find((x) => x.kind === "root") : view.rec.agents.find((x) => x.node === Number(m[2]));
      if (!a) return `process ${m[1]} has no agent ${m[2]}`;
      // A sub-agent lives inside its conversation: resuming it continues that conversation.
      for (let i = 0; a.kind !== "root" && a.parent !== undefined && i < 10; i++) a = view.rec.agents.find((x) => x.node === a!.parent) ?? a;
      if (!a.session) return `${m[1]}.${a.node} has no saved session (a conversation is saved from its first answer)`;
      const hit = saved.find((s) => s.file === a!.session);
      return hit ?? `${m[1]}.${a.node}'s session file is gone: ${a.session}`;
    }
  }
  const byId = saved.filter((s) => s.id.toLowerCase().startsWith(r));
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) return `${byId.length} sessions start with ${ref}: give more of the id`;
  return `no agent or saved session ${ref} (mnemo agents saved lists them)`;
}

/** Conversations in `cwd` that were cut off when their process died: said once, at start. */
export function interruptedIn(saved: Saved[], cwd: string): Saved[] {
  const here = realpath(cwd);
  return saved.filter((s) => s.state === "interrupted" && realpath(s.cwd) === here);
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
