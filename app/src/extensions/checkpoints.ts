/**
 * Files are kept before the agent changes them (runtime/checkpoints.ts), so
 * esc esc or /rewind can take the project back with the conversation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realPath, toolTarget } from "../policy/paths.ts";
import { changedSince, snapshot, type Snapshot } from "../runtime/shell-snapshot.ts";
import type { Host } from "./host.ts";

const WRITES = new Set(["edit", "write"]);
/** Tools that change files in ways no argument names: what changed is found by comparing before and after. */
const RUNS = new Set(["bash", "ipy_run"]);

/** The id of the latest user message on the session's current branch. */
export function currentTurn(entries: readonly { id: string; type: string; message?: { role?: string } }[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "message" && e.message?.role === "user") return e.id;
  }
  return undefined;
}

export function checkpointsExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const store = host.checkpoints;
    if (!store) return;
    pi.on("tool_call", (event, ctx) => {
      if (!WRITES.has(event.toolName)) return undefined;
      const file = (event.input as { path?: unknown } | undefined)?.path;
      if (typeof file !== "string" || !file) return undefined;
      // A sub-agent's turn is its parent's: that is the message a rewind goes back to.
      if (host.depth === 0) store.turn = currentTurn(ctx.sessionManager.getBranch());
      // The file the tool will really write: `@src/a.ts`, `~/x` and `file://` resolved as
      // pi resolves them, and through symlinks, so a rewind puts back that file.
      const target = toolTarget(ctx.cwd, file);
      if (target !== undefined) store.keep(realPath(target) ?? target);
      return undefined;
    });

    // Taken when the command starts (after any approval), so the user's own edits while a question was open are not its.
    const before = new Map<string, { snap: Snapshot; turn: string | undefined }>();
    pi.on("tool_execution_start", (event, ctx) => {
      if (!RUNS.has(event.toolName)) return;
      const snap = snapshot(ctx.cwd);
      if (snap) before.set(event.toolCallId, { snap, turn: host.depth === 0 ? currentTurn(ctx.sessionManager.getBranch()) : store.turn });
    });
    pi.on("tool_execution_end", (event) => {
      const taken = before.get(event.toolCallId);
      if (!taken) return;
      before.delete(event.toolCallId);
      if (host.depth === 0) store.turn = taken.turn;
      for (const c of changedSince(taken.snap)) store.keep(realPath(c.file) ?? c.file, taken.turn, c.before);
    });
  };
}
