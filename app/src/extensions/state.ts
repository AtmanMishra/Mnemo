/**
 * A saved session's state file (`<session>.state.json`, see runtime/session-files.ts): what
 * the conversation and its sub-agents are doing, written by this process as the roster
 * changes, so another tool, terminal or person can read it without asking Mnemo.
 *
 * It keeps every sub-agent this session started, also the ones the live roster has let go
 * of (`LIMITS.keepEnded`). It also prunes old sub-agent transcripts (`keepSubTranscripts`).
 * Only a root writes; a session that is not saved (tests, `-p` without a file) writes nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Host } from "./host.ts";
import { pruneSubTranscripts, stateFileOf, stateNode, writeState, type StateNode } from "../runtime/session-files.ts";

/** How long a burst of roster changes is gathered into one write. */
const SETTLE_MS = 250;

export function stateExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    if (host.depth > 0) return;
    let file: string | undefined;
    let transcript = "";
    let session = "";
    let cwd = "";
    let model: string | undefined;
    let since = 0;
    const seen = new Map<number, StateNode>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const write = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      // pi creates the transcript at the first reply; until then there is nothing to describe.
      if (!file || !fs.existsSync(transcript)) return;
      const root = host.roster.get(host.node);
      if (!root) return;
      look();
      try {
        writeState(file, {
          version: 1,
          session,
          transcript,
          pid: process.pid,
          cwd,
          updatedAt: Date.now(),
          mode: host.mode,
          model,
          status: root.status,
          nodes: [...seen.values()].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id),
        });
      } catch {
        /* a full disk must not stop the conversation */
      }
    };
    // Taken at every change, not only when writing: a sub-agent can end and leave the live roster in between.
    const look = () => {
      const root = host.roster.get(host.node);
      if (!root || !file) return;
      seen.set(root.id, stateNode(root));
      for (const n of host.roster.descendants(root.id)) if (n.startedAt >= since) seen.set(n.id, stateNode(n));
    };
    const soon = () => {
      look();
      if (!file || timer) return;
      timer = setTimeout(write, SETTLE_MS);
      timer.unref?.();
    };
    const unsubscribe = host.roster.subscribe(soon);

    pi.on("session_start", async (_e, ctx) => {
      const f = ctx.sessionManager.getSessionFile();
      transcript = f ?? "";
      file = f ? stateFileOf(f) : undefined;
      session = ctx.sessionManager.getSessionId();
      cwd = ctx.cwd;
      model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      since = Date.now();
      seen.clear();
      if (f) pruneSubTranscripts(path.dirname(path.dirname(f)), host.settings.get().keepSubTranscripts);
    });
    pi.on("model_select", async (e) => {
      model = `${e.model.provider}/${e.model.id}`;
      soon();
    });
    pi.on("agent_end", async () => write());
    pi.on("session_shutdown", async () => {
      unsubscribe();
      write();
    });
  };
}
