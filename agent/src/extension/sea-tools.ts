/**
 * pi extension wrapper: registers all sea-agent tools through pi's extension
 * mechanism so they appear in any pi session:
 *
 *   pi -e /path/to/agent/src/extension/sea-tools.ts
 *
 * or via settings.json:
 *   { "extensions": ["/path/to/agent/src/extension/sea-tools.ts"] }
 *
 * The same tool objects stay usable standalone (see test/*.test.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { allTools } from "../tools/index.ts";

export default function seaTools(pi: ExtensionAPI): void {
  for (const tool of allTools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as any,
      // details is optional on our ToolResult but required on pi's AgentToolResult
      execute: async (toolCallId: string, params: any, signal?: AbortSignal) =>
        (await tool.execute(toolCallId, params, signal)) as any,
    });
  }
}
