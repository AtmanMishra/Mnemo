/**
 * The transcript model: pi session events in, blocks out.
 *
 * Pure of any rendering, so a whole turn can be asserted on as data. Blocks are
 * kept in order and split in two: `committed` blocks are final and are printed
 * once into the terminal's scrollback (Ink `<Static>`); `live` blocks are still
 * changing and are redrawn every frame. A block only commits when every block
 * before it is final, so scrollback never comes out of order.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type Tone = "info" | "warn" | "error";

export type Block =
  | { kind: "welcome"; id: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; done: boolean }
  | { kind: "thinking"; id: string; text: string; done: boolean; startedAt: number; durationMs?: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: "pending" | "running" | "done" | "error";
      output: string;
      details?: unknown;
      durationMs?: number;
    }
  | { kind: "notice"; id: string; tone: Tone; text: string }
  | { kind: "memory"; id: string; title: string; items: string[] };

export interface Working {
  since: number;
  /** Rough count of streamed output tokens this run (chars / 4). */
  tokens: number;
}

export interface Snapshot {
  /** Bumped when the screen is cleared, so `<Static>` remounts empty. */
  epoch: number;
  committed: readonly Block[];
  live: readonly Block[];
  working: Working | null;
  queue: readonly string[];
}

function isFinal(b: Block): boolean {
  switch (b.kind) {
    case "assistant":
    case "thinking":
      return b.done;
    case "tool":
      return b.status === "done" || b.status === "error";
    default:
      return true;
  }
}

type Content = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Content[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

export class Transcript {
  private committed: Block[] = [];
  private live: Block[] = [];
  private working: Working | null = null;
  private queue: string[] = [];
  private epoch = 0;
  private seq = 0;
  private assistantSeq = 0;
  private listeners = new Set<() => void>();
  private snap: Snapshot;
  /** What memory recalled for a message, held until that message is on screen. */
  private pendingRecall: Block | undefined;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.snap = this.build();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): Snapshot => this.snap;

  private build(): Snapshot {
    return { epoch: this.epoch, committed: this.committed, live: this.live, working: this.working, queue: this.queue };
  }

  private changed(): void {
    let i = 0;
    while (i < this.live.length && isFinal(this.live[i]!)) i++;
    if (i > 0) {
      this.committed = [...this.committed, ...this.live.slice(0, i)];
      this.live = this.live.slice(i);
    } else {
      this.live = [...this.live];
    }
    this.snap = this.build();
    for (const l of this.listeners) l();
  }

  private nextId(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  private find<K extends Block["kind"]>(kind: K, id: string): Extract<Block, { kind: K }> | undefined {
    return this.live.find((b) => b.kind === kind && b.id === id) as Extract<Block, { kind: K }> | undefined;
  }

  private replace(block: Block): void {
    this.live = this.live.map((b) => (b.id === block.id && b.kind === block.kind ? block : b));
  }

  /** Append a block that did not come from the agent (welcome, notices). */
  push(block: { kind: "welcome" } | { kind: "notice"; tone: Tone; text: string } | { kind: "user"; text: string }): void {
    this.live.push({ ...block, id: this.nextId("b") } as Block);
    this.changed();
  }

  notice(text: string, tone: Tone = "info"): void {
    this.push({ kind: "notice", tone, text });
  }

  /**
   * A line from the memory loop. Recall happens before the user's message is
   * echoed, so it waits and appears right under that message instead of above it.
   */
  memory(title: string, items: string[] = [], options: { afterNextUser?: boolean } = {}): void {
    const block: Block = { kind: "memory", id: this.nextId("m"), title, items };
    if (options.afterNextUser) {
      this.pendingRecall = block;
      return;
    }
    this.live.push(block);
    this.changed();
  }

  /** Forget everything on screen; the session itself is untouched. */
  clear(): void {
    this.committed = [];
    this.live = this.live.filter((b) => !isFinal(b));
    this.epoch++;
    this.changed();
  }

  get isWorking(): boolean {
    return this.working !== null;
  }

  /** Rebuild the transcript from a session's stored messages (resume). */
  load(messages: readonly unknown[]): void {
    for (const raw of messages) {
      const m = raw as { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; details?: unknown };
      if (m.role === "user") {
        const text = textOf(m.content);
        if (text) this.live.push({ kind: "user", id: this.nextId("u"), text });
      } else if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const c of m.content as Content[]) {
          if (c.type === "text" && c.text) this.live.push({ kind: "assistant", id: this.nextId("a"), text: c.text, done: true });
          if (c.type === "thinking" && c.thinking)
            this.live.push({ kind: "thinking", id: this.nextId("t"), text: c.thinking, done: true, startedAt: 0 });
          if (c.type === "toolCall" && c.id)
            this.live.push({
              kind: "tool",
              id: c.id,
              name: c.name ?? "tool",
              args: (c.arguments ?? {}) as Record<string, unknown>,
              status: "pending",
              output: "",
            });
        }
      } else if (m.role === "toolResult" && m.toolCallId) {
        const tool = this.find("tool", m.toolCallId);
        if (tool)
          this.replace({ ...tool, status: m.isError ? "error" : "done", output: textOf(m.content), details: m.details });
      }
    }
    // A tool call with no stored result (the session ended mid-call) is shown
    // as interrupted rather than left spinning forever.
    this.live = this.live.map((b) => (b.kind === "tool" && !isFinal(b) ? { ...b, status: "error", output: "interrupted" } : b));
    this.changed();
  }

  apply(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        if (!this.working) this.working = { since: this.now(), tokens: 0 };
        break;

      case "agent_settled":
        this.working = null;
        this.settle();
        break;

      case "queue_update":
        this.queue = [...event.steering, ...event.followUp];
        break;

      case "message_start":
        if (event.message.role === "assistant") this.assistantSeq++;
        break;

      case "message_end": {
        const m = event.message as { role: string; content?: unknown; stopReason?: string; errorMessage?: string };
        if (m.role === "user") {
          const text = textOf(m.content);
          if (text) this.live.push({ kind: "user", id: this.nextId("u"), text });
          if (this.pendingRecall) {
            this.live.push(this.pendingRecall);
            this.pendingRecall = undefined;
          }
        } else if (m.role === "assistant") {
          this.finishMessage();
          if (m.stopReason === "aborted") this.live.push({ kind: "notice", id: this.nextId("n"), tone: "warn", text: "Interrupted" });
          else if (m.stopReason === "error")
            this.live.push({ kind: "notice", id: this.nextId("n"), tone: "error", text: m.errorMessage ?? "The model returned an error" });
        }
        break;
      }

      case "message_update":
        this.assistantDelta(event.assistantMessageEvent);
        break;

      case "tool_execution_start": {
        const existing = this.find("tool", event.toolCallId);
        if (existing) this.replace({ ...existing, status: "running" });
        else
          this.live.push({
            kind: "tool",
            id: event.toolCallId,
            name: event.toolName,
            args: (event.args ?? {}) as Record<string, unknown>,
            status: "running",
            output: "",
          });
        break;
      }

      case "tool_execution_update": {
        const tool = this.find("tool", event.toolCallId);
        if (tool) this.replace({ ...tool, output: textOf((event.partialResult as { content?: unknown })?.content) });
        break;
      }

      case "tool_execution_end": {
        const tool = this.find("tool", event.toolCallId);
        const result = event.result as { content?: unknown; details?: unknown } | undefined;
        if (tool)
          this.replace({
            ...tool,
            status: event.isError ? "error" : "done",
            output: textOf(result?.content),
            details: result?.details,
            durationMs: event.durationMs,
          });
        break;
      }

      case "compaction_start":
        this.live.push({ kind: "notice", id: this.nextId("n"), tone: "info", text: "Compacting the conversation…" });
        break;

      case "compaction_end":
        this.live.push({
          kind: "notice",
          id: this.nextId("n"),
          tone: event.errorMessage ? "error" : "info",
          text: event.errorMessage
            ? `Compaction failed: ${event.errorMessage}`
            : event.aborted
              ? "Compaction cancelled"
              : "Conversation compacted",
        });
        break;

      case "auto_retry_start":
        this.live.push({
          kind: "notice",
          id: this.nextId("n"),
          tone: "warn",
          text: `${event.errorMessage} — retrying in ${Math.round(event.delayMs / 1000)}s (${event.attempt}/${event.maxAttempts})`,
        });
        break;

      default:
        return;
    }
    this.changed();
  }

  private assistantDelta(e: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"]): void {
    const key = (i: number) => `m${this.assistantSeq}:${i}`;
    switch (e.type) {
      case "thinking_start":
        this.live.push({ kind: "thinking", id: key(e.contentIndex), text: "", done: false, startedAt: this.now() });
        break;
      case "thinking_delta": {
        const b = this.find("thinking", key(e.contentIndex));
        if (b) this.replace({ ...b, text: b.text + e.delta });
        this.count(e.delta);
        break;
      }
      case "thinking_end": {
        const b = this.find("thinking", key(e.contentIndex));
        if (b) this.replace({ ...b, text: e.content, done: true, durationMs: this.now() - b.startedAt });
        break;
      }
      case "text_start":
        this.live.push({ kind: "assistant", id: key(e.contentIndex), text: "", done: false });
        break;
      case "text_delta": {
        const b = this.find("assistant", key(e.contentIndex));
        if (b) this.replace({ ...b, text: b.text + e.delta });
        this.count(e.delta);
        break;
      }
      case "text_end": {
        const b = this.find("assistant", key(e.contentIndex));
        if (b) this.replace({ ...b, text: e.content, done: true });
        break;
      }
      case "toolcall_delta":
        this.count(e.delta);
        break;
      case "toolcall_end":
        if (!this.find("tool", e.toolCall.id))
          this.live.push({
            kind: "tool",
            id: e.toolCall.id,
            name: e.toolCall.name,
            args: e.toolCall.arguments as Record<string, unknown>,
            status: "pending",
            output: "",
          });
        break;
      default:
        break;
    }
  }

  private count(delta: string): void {
    if (this.working) this.working = { ...this.working, tokens: this.working.tokens + Math.ceil(delta.length / 4) };
  }

  /** Close the text and thinking blocks of the message that just ended. */
  private finishMessage(): void {
    const now = this.now();
    this.live = this.live.map((b) =>
      b.kind === "assistant" && !b.done
        ? { ...b, done: true }
        : b.kind === "thinking" && !b.done
          ? { ...b, done: true, durationMs: now - b.startedAt }
          : b,
    );
    // An empty answer (the model went straight to tool calls) is not a block.
    this.live = this.live.filter((b) => !(b.kind === "assistant" && b.done && !b.text.trim()));
  }

  /** The run is over: nothing may stay live, or it would never reach scrollback. */
  private settle(): void {
    this.finishMessage();
    this.live = this.live.map((b) => (b.kind === "tool" && !isFinal(b) ? { ...b, status: "error", output: b.output || "interrupted" } : b));
  }
}
