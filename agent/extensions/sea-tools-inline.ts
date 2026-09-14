/**
 * sea-tools inline extension: registers ALL sea-agent tools through pi's
 * InlineExtension mechanism so they are active in every mode pi's main()
 * supports (interactive, print, JSON, RPC) without any per-session glue.
 *
 * Registered tools:
 *   bash_exec, read_file, write_file, apply_edit, glob_list, ipy_run,
 *   list_skills, load_skill, create_skill, patch_skill, retire_skill,
 *   create_harness, spawn_subagent, memory_search, memory_write_fact,
 *   memory_steer
 *
 * The SeaTool objects in src/tools stay the source of truth; they are already
 * structurally compatible with pi's ToolDefinition (name/label/description/
 * parameters/execute), so the adapter only normalizes the execute() signature
 * and result shape.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { allTools } from "../src/tools/index.ts";
import { sharedKernel } from "../src/tools/ipy_run.ts";
import { makeKernelDispatcher } from "../src/tools/kernel_tools.ts";
import { decideApproval } from "./approval-gate.ts";
import { loadPermissions } from "../src/permissions.ts";
import { getMcpTools } from "../src/mcp.ts";
import { makeMemoryTools } from "./memory-layer.ts";

/** All 19 tool names this extension registers (16 core + 3 memory). */
export const SEA_TOOL_NAMES: string[] = [
  ...allTools.map((t) => t.name),
  ...makeMemoryTools().map((t) => t.name),
];

/** Exported for the adapter's own tests: normalizes a SeaTool for pi. */
export function toToolDefinition(tool: any): any {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    // details is optional on our ToolResult but part of AgentToolResult on pi.
    // pi hands every tool its ExtensionContext (5th argument), which is how a
    // tool learns the live session for PI_* child-shell env (D6) and whether
    // a dialog UI exists.
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) =>
      (await tool.execute(toolCallId, params, signal, onUpdate, ctx)) as any,
  };
}

/** Factory: registers every sea tool onto an ExtensionAPI. */
export function seaToolsFactory(pi: any): void {
  // MCP tools are discovered before main() runs; see bin/mnemo.ts
  const tools = [...allTools, ...makeMemoryTools(), ...getMcpTools()];

  // A globally-installed pi package (e.g. pi-web-access) may already
  // register web_search/web_fetch. Two tools with the same name make pi
  // refuse to load OUR extension entirely ("Tool X conflicts with ..."),
  // which kills the whole agent at session start. We can't ask the runtime
  // what it has while the extension is still LOADING (getAllTools is an
  // action method), so: register everything except the conflict-prone web
  // tools now, and claim those at session_start only if nobody else did.
  const webTools = tools.filter((t) => t.name === "web_search" || t.name === "web_fetch");
  const immediate = tools.filter((t) => t.name !== "web_search" && t.name !== "web_fetch");
  for (const tool of immediate) {
    pi.registerTool(toToolDefinition(tool));
  }

  // 4.6/4.7: the same tools, callable as `tools.<name>(...)` from inside
  // ipy_run, and gated by the same rules a normal tool call goes through.
  // Prompting is impossible from in here (a cell is not a tool-call loop with
  // a dialog UI), so an "ask" resolves to allow exactly as it does in a run
  // with no UI — while a deny rule and plan mode still block. The kernel's
  // session context rides along so a child shell spawned by an in-kernel
  // bash_exec still publishes the session's PI_* values (D6).
  const perms = loadPermissions();
  const setDispatcher = (list: any[]) =>
    sharedKernel.setToolDispatcher(
      makeKernelDispatcher(list, (name, args) =>
        decideApproval({ toolName: name, input: args },
          { confirm: async () => true }, process.env, false, perms),
        "kernel",
        () => sharedKernel.toolContext()),
    );
  setDispatcher(immediate);

  if (webTools.length > 0) {
    // Claim web tools at session_start when the runtime is queryable and
    // nobody else owns the name. Tools registered here are refreshed in the
    // same session before the first turn (see pi docs: registerTool works
    // in session_start), and the dispatcher follows the same list.
    pi.on("session_start", () => {
      const existing = new Set((pi.getAllTools?.() ?? []).map((t: any) => t.name));
      const add = webTools.filter((t) => !existing.has(t.name));
      if (add.length === 0) return;
      for (const tool of add) pi.registerTool(toToolDefinition(tool));
      setDispatcher([...immediate, ...add]);
    });
  }
}

/** Named inline extension so it shows as <inline:sea-tools> at startup. */
export const seaToolsInline: InlineExtension = {
  name: "sea-tools",
  factory: seaToolsFactory as any,
};

export default seaToolsInline;
