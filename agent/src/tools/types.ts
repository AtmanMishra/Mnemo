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

export interface ToolResult {
  content: TextContent[];
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
export function textResult(text: string, details?: unknown): ToolResult {
  return details === undefined ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], details };
}
