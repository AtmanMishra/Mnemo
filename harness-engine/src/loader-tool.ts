/**
 * Loader-tool helper (pi lazy-activation pattern): one stable model-facing
 * tool ("load_tools") whose execute() activates named tools and returns their
 * schemas, instead of shipping every tool's schema in every request.
 */
import type { ToolRegistry } from "./registry.ts";

export interface LoaderToolInput {
  names: string[];
}

export interface LoaderToolResult {
  activated: Array<{ name: string; scope: string; schema: unknown }>;
  missing: string[];
  activeTools: string[];
}

export interface LoaderTool {
  name: "load_tools";
  description: string;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    [k: string]: unknown;
  };
  execute(params: LoaderToolInput): Promise<string>;
}

const LOADER_SCHEMA = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "string" },
      description: "Tool names to activate. Use list/registry output or known names.",
    },
  },
  required: ["names"],
} as const;

export function getLoaderTool(registry: ToolRegistry): LoaderTool {
  return {
    name: "load_tools",
    description:
      "Activate named tools lazily. Returns the JSON schema of each newly active tool " +
      "so you can call them on the next turn. Prefer this over loading all tools upfront.",
    schema: LOADER_SCHEMA as unknown as LoaderTool["schema"],
    async execute(params: LoaderToolInput): Promise<string> {
      const names = params?.names;
      if (!Array.isArray(names)) throw new Error("load_tools: 'names' must be an array of strings");
      const result: LoaderToolResult = { activated: [], missing: [], activeTools: [] };
      for (const raw of names) {
        const name = String(raw);
        const found = registry.resolve(name);
        if (!found) {
          result.missing.push(name);
          continue;
        }
        registry.activateTool(name);
        result.activated.push({ name, scope: found.scope, schema: found.tool.schema });
      }
      result.activeTools = registry.getActive();
      return JSON.stringify(result, null, 2);
    },
  };
}
