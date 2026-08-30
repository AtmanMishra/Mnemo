/**
 * 5.2/5.3/5.4: turn pi's session events into spans.
 *
 * Tool calls and model round trips become nested spans under one session span,
 * and a subagent's spans carry the parent's session id, so `mnemo traces`
 * reconstructs the whole delegation tree from one file.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Tracer, type Span } from "../src/trace.ts";

/** Env var a parent uses to hand its session and span down to a subagent. */
export const PARENT_SESSION_ENV = "MNEMO_TRACE_PARENT_SESSION";
export const PARENT_SPAN_ENV = "MNEMO_TRACE_PARENT_SPAN";

/** Arguments worth keeping on a tool span. Bodies are summarised, not stored. */
export function summarizeArgs(args: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      out[k] = v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
    } else if (Array.isArray(v)) {
      out[k] = `[${v.length} items]`;
    } else if (v && typeof v === "object") {
      out[k] = "{…}";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** How big was the result, without putting the result in the log. */
export function outputSize(result: unknown): number {
  if (result === undefined || result === null) return 0;
  if (typeof result === "string") return result.length;
  try {
    return JSON.stringify(result).length;
  } catch {
    return -1;
  }
}

export interface TracingHandles {
  tracer: Tracer;
  /** Close the session span. */
  finish: () => void;
}

/**
 * Wire a tracer onto an ExtensionAPI. Exported separately from the extension
 * so tests can drive it with a fake pi and a fake clock.
 */
export function attachTracing(pi: ExtensionAPI | any, tracer: Tracer, env: NodeJS.ProcessEnv = process.env): TracingHandles {
  const parentSession = env[PARENT_SESSION_ENV];
  const parentSpan = env[PARENT_SPAN_ENV];

  const closeSession = tracer.start(
    parentSession ? "subagent" : "session",
    parentSession ? "subagent run" : "session",
    { parent_session: parentSession, cwd: process.cwd() },
    // a subagent's root hangs off the parent's span id (5.4)
    parentSpan ?? null,
  );

  const open = new Map<string, (r?: { ok?: boolean; attrs?: Record<string, unknown> }) => Span>();

  pi.on?.("tool_call", (event: any) => {
    const key = String(event?.toolCallId ?? event?.toolName ?? "tool");
    open.set(key, tracer.start("tool", String(event?.toolName ?? "tool"), {
      args: summarizeArgs(event?.input ?? event?.args ?? {}),
    }));
    return {};
  });

  pi.on?.("tool_result", (event: any) => {
    const key = String(event?.toolCallId ?? event?.toolName ?? "tool");
    const close = open.get(key);
    open.delete(key);
    close?.({
      ok: !event?.isError,
      attrs: { output_bytes: outputSize(event?.result ?? event?.output) },
    });
    return {};
  });

  // 5.2: one span per model round trip
  pi.on?.("turn_start", () => {
    open.set("__turn__", tracer.start("llm", "model round trip", {}));
    return {};
  });

  pi.on?.("turn_end", (event: any) => {
    const close = open.get("__turn__");
    open.delete("__turn__");
    const msg = event?.message ?? {};
    const usage = msg?.usage ?? {};
    close?.({
      ok: msg?.stopReason !== "error",
      attrs: {
        provider: msg?.provider,
        model: msg?.model,
        tokens_in: usage?.input,
        tokens_out: usage?.output,
        cost: usage?.cost?.total,
        stop_reason: msg?.stopReason,
      },
    });
    return {};
  });

  return {
    tracer,
    finish: () => {
      // close anything still open so a crash mid-tool does not leave a
      // span that never ends
      for (const [, close] of open) close({ ok: false, attrs: { unfinished: true } });
      open.clear();
      closeSession({ ok: true });
    },
  };
}

/** Env a subagent should inherit so its spans join the parent's tree (5.4). */
export function childTraceEnv(tracer: Tracer): Record<string, string> {
  return {
    [PARENT_SESSION_ENV]: tracer.session,
    ...(tracer.currentSpanId ? { [PARENT_SPAN_ENV]: tracer.currentSpanId } : {}),
  };
}

let active: TracingHandles | null = null;

export function activeTracing(): TracingHandles | null {
  return active;
}

export function tracingFactory(pi: any): void {
  const tracer = new Tracer();
  active = attachTracing(pi, tracer);
  const finish = () => active?.finish();
  pi.on?.("shutdown", finish);
  process.once("exit", finish);
}

export const tracingExt: InlineExtension = {
  name: "sea-tracing",
  factory: tracingFactory as any,
};

export default tracingExt;
