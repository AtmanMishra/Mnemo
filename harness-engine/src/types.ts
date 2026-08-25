/** Core data contracts for the harness engine. */

/**
 * JSON-schema-ish description of a tool's parameters.
 * Kept loose on purpose: schemas arrive from LLM-generated tool files and
 * must survive a JSON round-trip, not satisfy a strict TS type.
 */
export interface ToolSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** Contract every tool file must fulfill via its default export. */
export interface ToolDefinition {
  name: string;
  description?: string;
  schema: ToolSchema;
  execute(params: Record<string, unknown>): Promise<string>;
}

export type ToolModule = { default: ToolDefinition };

/** manifest.json of a skill bundle. `tools` are file refs relative to the bundle dir. */
export interface BundleManifest {
  name: string;
  version: string;
  description: string;
  tools: string[];
}

export interface Disposable {
  dispose(): void | Promise<void>;
}

/** Registry scopes, lowest to highest precedence. Nearest layer wins. */
export type ScopeName = "global" | "project" | "session";

export const SCOPE_ORDER: readonly ScopeName[] = ["global", "project", "session"];
