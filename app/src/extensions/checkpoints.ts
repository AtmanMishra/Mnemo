/**
 * Files are kept before the agent changes them (runtime/checkpoints.ts), so
 * esc esc or /rewind can take the project back with the conversation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realPath, toolTarget } from "../policy/paths.ts";
import type { Host } from "./host.ts";

const WRITES = new Set(["edit", "write"]);

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
  };
}
