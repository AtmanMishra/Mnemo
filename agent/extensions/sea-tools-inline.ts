/**
 * sea-tools inline extension: registers ALL sea-agent tools through pi's
 * InlineExtension mechanism so they are active in every mode pi's main()
 * supports (interactive, print, JSON, RPC) without any per-session glue.
 *
 * Registered tools:
 *   bash_exec, read_file, write_file, apply_edit, glob_list, ipy_run,
 *   list_skills, load_skill, create_skill, create_harness, spawn_subagent,
 *   memory_search, memory_write_fact, memory_steer
 *
 * The SeaTool objects in src/tools stay the source of truth; they are already
 * structurally compatible with pi's ToolDefinition (name/label/description/
 * parameters/execute), so the adapter only normalizes the execute() signature
 * and result shape.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { allTools } from "../src/tools/index.ts";
import { makeMemoryTools } from "./memory-layer.ts";

/** All 14 tool names this extension registers (11 core + 3 memory). */
export const SEA_TOOL_NAMES: string[] = [
  ...allTools.map((t) => t.name),
  ...makeMemoryTools().map((t) => t.name),
];

function toToolDefinition(tool: any): any {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    // details is optional on our ToolResult but part of AgentToolResult on pi.
    execute: async (toolCallId: string, params: any, signal?: AbortSignal) =>
      (await tool.execute(toolCallId, params, signal)) as any,
  };
}

/** Factory: registers every sea tool onto an ExtensionAPI. */
export function seaToolsFactory(pi: any): void {
  for (const tool of [...allTools, ...makeMemoryTools()]) {
    pi.registerTool(toToolDefinition(tool));
  }
}

/** Named inline extension so it shows as <inline:sea-tools> at startup. */
export const seaToolsInline: InlineExtension = {
  name: "sea-tools",
  factory: seaToolsFactory as any,
};

export default seaToolsInline;
