/**
 * Minimal local tool contract. Structurally compatible with pi's
 * `ToolDefinition` (from @earendil-works/pi-coding-agent), so these objects can
 * be passed as `customTools` to createAgentSession() or registered from an
 * extension via pi.registerTool(), while remaining trivially callable
 * standalone in tests: `await tool.execute("call-id", args)`.
 */
import { Type, type TSchema } from "typebox";
import type { PiSessionEnv } from "../childenv.ts";

export interface TextContent {
  type: "text";
  text: string;
}

/** Structurally pi's ImageContent, so a tool can hand the model a picture. */
export interface ImageContent {
  type: "image";
  /** base64, no data: prefix. */
  data: string;
  mimeType: string;
}

export interface ToolResult {
  content: (TextContent | ImageContent)[];
  details?: unknown;
}

export type ToolUpdateCallback = (partial: ToolResult) => void;

/**
 * What a tool needs to know about the run it is executing inside.
 *
 * Structurally the slice of pi's ExtensionContext our tools read, so pi's
 * real context (5th argument of a tool execute()) is assignable to it, and so
 * are the plain objects tests and the in-kernel dispatcher pass.
 * `sessionEnv` is ours, not pi's: the dispatcher has no ExtensionContext, so
 * it hands the already-resolved session facts over directly.
 */
export interface ToolContext {
  /** Session facts for child shells (src/childenv.ts). Wins over the manager. */
  sessionEnv?: PiSessionEnv;
  sessionManager?: {
    getSessionId?(): string;
    getSessionFile?(): string | undefined | null;
  };
  model?: { provider?: string; id?: string } | undefined;
  thinkingLevel?: string | undefined;
  /** Whether dialog-capable UI is available (pi: true in tui and rpc modes). */
  hasUI?: boolean;
  mode?: string;
}

export interface SeaTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
    ctx?: ToolContext,
  ): Promise<ToolResult>;
}

export const TypeBox = Type;

/** The text of a result's Nth content block. Narrows the text/image union. */
export function textOf(result: ToolResult, index = 0): string {
  const block = result.content[index];
  return block && block.type === "text" ? block.text : "";
}

export function imageResult(
  data: string,
  mimeType: string,
  caption: string,
): ToolResult {
  // the caption goes first so a model that cannot see images still knows what
  // it was handed, instead of receiving a silent blob
  return { content: [{ type: "text", text: caption }, { type: "image", data, mimeType }] };
}
export function textResult(text: string, details?: unknown): ToolResult {
  return details === undefined ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], details };
}
