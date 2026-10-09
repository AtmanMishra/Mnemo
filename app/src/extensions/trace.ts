/**
 * One JSON line per tool call, turn and run in `$MNEMO_HOME/logs/<date>.jsonl`.
 *
 * Enough to answer "what did it do, how long did it take, what did it cost"
 * after the fact. Arguments are reduced to the subject (a command, a path) and
 * everything written is passed through `redact` first, so a key that appears
 * in a command line never reaches the disk.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redact } from "@mnemo/memory";
import type { Host } from "./host.ts";

export { redact };

export function traceExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const dir = path.join(host.home, "logs");
    let session = "";
    const write = (record: Record<string, unknown>) => {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const day = new Date().toISOString().slice(0, 10);
        fs.appendFileSync(path.join(dir, `${day}.jsonl`), `${redact(JSON.stringify({ ts: new Date().toISOString(), session, depth: host.depth, ...record }))}\n`, { mode: 0o600 });
      } catch {
        // Tracing is never worth a failed turn.
      }
    };
    pi.on("session_start", async (_e, ctx) => {
      session = ctx.sessionManager.getSessionId();
    });
    const starts = new Map<string, string>();
    pi.on("tool_execution_start", async (e) => {
      const a = (e.args ?? {}) as Record<string, unknown>;
      starts.set(e.toolCallId, String(a.command ?? a.path ?? a.pattern ?? "").split("\n")[0]!.slice(0, 200));
    });
    pi.on("tool_execution_end", async (e) => {
      write({ type: "tool", tool: e.toolName, subject: starts.get(e.toolCallId), ok: !e.isError, ms: e.durationMs });
      starts.delete(e.toolCallId);
    });
    pi.on("turn_end", async (e) => {
      const m = e.message as { usage?: { input: number; output: number; cost?: { total: number } }; stopReason?: string; model?: string };
      write({ type: "turn", model: m.model, stop: m.stopReason, in: m.usage?.input, out: m.usage?.output, cost: m.usage?.cost?.total });
    });
  };
}
