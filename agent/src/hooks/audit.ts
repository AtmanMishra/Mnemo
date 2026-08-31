/**
 * AREA 9.4 — hook audit trail.
 *
 * Every hook invocation (match decision, command, duration, exit, block
 * reason, result delta) lands in the SAME ~/.mnemo/logs/<date>.jsonl as the
 * existing tracer spans — one file, one redaction policy (trace.ts redacts
 * keys and secret-shaped strings on the way out; nothing a hook does is
 * invisible). A hook that opts out with on.audit=false still gets its
 * lifecycle row written here by the engine; `audit` controls HOW MUCH goes
 * in, not WHETHER the row exists.
 */
import { Tracer, type Level, type Span } from "../trace.ts";

export interface AuditAttrs extends Record<string, unknown> {
  hook: string;
  scope?: string;
  trigger?: string;
  tool?: string;
  matched?: boolean;
  command?: string;
  exit?: number;
  duration_ms?: number;
  timed_out?: boolean;
  block?: boolean;
  reason?: string;
  modified?: boolean;
}

export interface AuditSink {
  event(name: string, attrs: AuditAttrs): Span;
}

/** Lazy tracer: the file is only touched on the first invocation. */
export class HookAudit implements AuditSink {
  private tracer: Tracer | null = null;
  private readonly home?: string;
  private readonly level?: Level;
  private readonly now?: () => number;

  constructor(opts: { home?: string; level?: Level; now?: () => number } = {}) {
    this.home = opts.home;
    this.level = opts.level;
    this.now = opts.now;
  }

  private get t(): Tracer {
    return (this.tracer ??= new Tracer({ home: this.home, level: this.level, now: this.now }));
  }

  /** One invocation row. Never throws: a full audit log must not break the loop. */
  event(name: string, attrs: AuditAttrs): Span {
    try {
      return this.t.event(name, attrs as Record<string, unknown>);
    } catch {
      // audit is best-effort by contract; pretend we wrote it
      return { id: "audit-failed", parent_id: null, session: "", kind: "event", name, start: 0, attrs: {} };
    }
  }
}

export function auditInvocation(sink: AuditSink, attrs: AuditAttrs): void {
  sink.event("hook", attrs);
}