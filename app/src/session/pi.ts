/**
 * pi's events in, our events out.
 *
 * The loop is pi's; the vocabulary is ours. This file is the whole translation —
 * a pure function over event objects, plus a small runner that subscribes and
 * feeds a Session. Between them they are the only code in the application that
 * knows pi's event names, which is what makes "replace the loop" a change to one
 * file rather than to the interface.
 *
 * The types below are deliberately *structural*: the adapter describes the shape
 * it reads rather than importing pi's union. A test can then hand it a plain
 * object, and a future version of pi that renames something fails in the test
 * that names the field, not in a render nobody can reproduce.
 */
import type { Session } from "./session.ts";
import type { SessionEvent } from "./events.ts";
import type { TranscriptRender } from "../transcript/transcript.ts";

/** The parts of pi's event stream this adapter reads. */
export interface PiLikeEvent {
  type: string;
  message?: { role?: string; errorMessage?: string };
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

const SUMMARY_LIMIT = 60;

/** One line, no newlines, bounded — a summary is for a row, not a document. */
export function shorten(text: string, limit = SUMMARY_LIMIT): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "target"];

/**
 * What to show beside a tool's name while it runs.
 *
 * A tool call is recognisable by its subject, not its arguments: `bash — npm test`
 * is useful, the full argv is not. Unknown tools get nothing rather than a
 * JSON blob, because a row that has to be read carefully is worse than a row
 * that says only what it is.
 */
export function summarizeToolArgs(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") return shorten(record.command);
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return shorten(value);
  }
  if (typeof record.query === "string") return shorten(record.query);
  return undefined;
}

/** What to show when a tool reports: its first meaningful line, or nothing. */
export function summarizeToolResult(result: unknown): string | undefined {
  if (typeof result === "string") return result.trim() ? shorten(result) : undefined;
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ["stdout", "text", "message", "output"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return shorten(value);
  }
  return undefined;
}

/**
 * Translate one pi event into zero or more session events.
 *
 * Returning an empty array is the common case and an explicit choice: most of
 * what a loop emits is not something a reader needs to see, and silently
 * dropping it here is better than teaching every block to ignore it.
 */
export function toSessionEvents(event: PiLikeEvent): SessionEvent[] {
  switch (event.type) {
    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") {
        return [{ type: "assistant-delta", text: delta.delta }];
      }
      return [];
    }
    case "message_end": {
      // Only an assistant message ends an answer; a user or tool-result message
      // ending is not the answer finishing.
      if (event.message?.role !== "assistant") return [];
      const done: SessionEvent[] = [{ type: "assistant-done" }];
      // A rejected request arrives as an assistant message with no content and
      // an error on it — indistinguishable, without this, from a model that
      // answered with nothing. Found by pointing the spine at a real provider
      // with a bad key: the turn produced an empty screen and exit code 0, which
      // is the worst way for a failure to present itself.
      if (event.message.errorMessage) {
        done.push({
          type: "notice",
          text: `the model could not answer — ${event.message.errorMessage}`,
          tone: "error",
        });
      }
      return done;
    }

    case "tool_execution_start":
      return [
        {
          type: "tool-start",
          id: String(event.toolCallId ?? ""),
          name: String(event.toolName ?? "tool"),
          summary: summarizeToolArgs(String(event.toolName ?? ""), event.args),
        },
      ];

    case "tool_execution_end":
      return [
        {
          type: "tool-end",
          id: String(event.toolCallId ?? ""),
          ok: event.isError !== true,
          summary: summarizeToolResult(event.result),
        },
      ];

    case "turn_end":
      return [{ type: "turn-end" }];

    default:
      return [];
  }
}

/** The slice of pi's AgentSession this runner uses. */
export interface PiSessionLike {
  subscribe(listener: (event: PiLikeEvent) => void): () => void;
  prompt(text: string): Promise<void>;
}

export interface RunTurnOptions {
  width: number;
  /** Called with every frame worth painting, in order. */
  onFrame: (render: TranscriptRender) => void;
  /** Called for events the session produced, for logging or assertions. */
  onEvent?: (event: SessionEvent) => void;
}

/**
 * Send a prompt and paint the turn.
 *
 * The subscription is torn down in a `finally`: a runner that leaves a listener
 * attached keeps painting frames for a session nobody is watching, and that is
 * the kind of leak that shows up as a flickering screen rather than an error.
 */
export async function runTurn(
  pi: PiSessionLike,
  session: Session,
  text: string,
  options: RunTurnOptions,
): Promise<void> {
  const paint = () => options.onFrame(session.render(options.width));

  const unsubscribe = pi.subscribe((event) => {
    for (const translated of toSessionEvents(event)) {
      session.apply(translated);
      options.onEvent?.(translated);
      if (translated.type !== "assistant-delta") paint();
    }
    // A delta changes nothing until the line ends: painting per chunk would
    // redraw the same row dozens of times a second for no visible difference.
    if (event.type === "message_update") paint();
  });

  try {
    // The events the runner synthesizes are reported too: an observer should see
    // the stream the session actually saw, not just the part that came from the
    // loop. Otherwise every consumer has to know which events were "real".
    const userEvent = { type: "user", text } as const;
    session.apply(userEvent);
    options.onEvent?.(userEvent);
    paint();
    await pi.prompt(text);
  } finally {
    unsubscribe();
    // A safety net, not a second opinion. pi reports `turn_end` itself when the
    // loop finishes a turn; this fires only when the prompt ended without one —
    // an abort, a failure, a provider that died mid-stream. Synthesizing it
    // unconditionally would double the event on every normal turn, and a stream
    // where "the turn is over" appears twice is a stream nobody can reason about.
    if (session.streaming) {
      const endEvent = { type: "turn-end" } as const;
      session.apply(endEvent);
      options.onEvent?.(endEvent);
      paint();
    }
  }
}
