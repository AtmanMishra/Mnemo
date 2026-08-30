/**
 * Minimal local tool contract. Structurally compatible with pi's
 * `ToolDefinition` (from @earendil-works/pi-coding-agent), so these objects can
 * be passed as `customTools` to createAgentSession() or registered from an
 * extension via pi.registerTool(), while remaining trivially callable
 * standalone in tests: `await tool.execute("call-id", args)`.
 */
import { Type, type TSchema } from "typebox";

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
