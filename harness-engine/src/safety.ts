/**
 * Safety gate for LLM-generated tool source.
 *
 * What this DOES:
 *  - scans static imports, dynamic import(), and require() specifiers
 *  - rejects blocked modules ('fs', 'child_process', ...) unless explicitly allowlisted
 *  - enforces a syntactically plausible module via an AsyncFunction compile check
 *    (ESM import/export lines are stripped/transformed first)
 *  - validates the shape of a loaded ToolDefinition (schema present, execute fn)
 *
 * What this does NOT do (be honest with yourself):
 *  - it is NOT a sandbox. Once a bundle is registered, execute() runs with full
 *    Node.js privileges inside this process. The gate only filters what gets
 *    loaded; it cannot stop a tool from using indirect escapes (process,
 *    process.binding, prototype pollution, network via fetch, dynamic
 *    import of non-blocked builtins like 'os', 'net', 'node:http', ...).
 *  - it cannot see through obfuscated specifiers constructed at runtime
 *    (e.g. import(["child","_process"].join(""))).
 * For real isolation, run tools in a worker/child with restricted permissions
 * (e.g. node --permission) or in a container. See README "Security notes".
 */
import type { ToolDefinition, ToolSchema } from "./types.ts";

const DEFAULT_BLOCKED = new Set([
  "child_process",
  "fs",
  "fs/promises",
]);

export interface SafetyOptions {
  /** Module specifiers that may bypass the blocklist, e.g. ["node:fs"]. Compared normalized. */
  allowModules?: string[];
}

export type SafetyIssueKind =
  | "import"
  | "schema"
  | "execute"
  | "syntax"
  | "name"
  | "shape";

export interface SafetyIssue {
  kind: SafetyIssueKind;
  message: string;
}

export interface SafetyReport {
  ok: boolean;
  issues: SafetyIssue[];
}

function normalizeSpec(spec: string): string {
  return spec.startsWith("node:") ? spec.slice("node:".length) : spec;
}

/** Extract every plausible module specifier from a source string. */
export function extractImportSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  // static: import x from 'm' / import {a} from "m" / import 'm' / multi-line clauses
  const staticRe = /(?:^|[;\n}])\s*import\s+(?:[\w$*\s{},]+?\s+from\s+)?["']([^"']+)["']/g;
  // dynamic: await import('m')
  const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  // cjs: require('m')
  const reqRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(source))) specs.add(m[1]!);
  while ((m = dynRe.exec(source))) specs.add(m[1]!);
  while ((m = reqRe.exec(source))) specs.add(m[1]!);
  return [...specs];
}

export function isBlockedSpecifier(
  spec: string,
  allowModules: readonly string[] = [],
): boolean {
  if (spec.startsWith(".") || spec.startsWith("/")) return false; // relative refs stay inside the bundle
  const norm = normalizeSpec(spec);
  const allowed = new Set(allowModules.map(normalizeSpec));
  return DEFAULT_BLOCKED.has(norm) && !allowed.has(norm);
}

/**
 * Compile-check ESM-ish source without executing it.
 * Static imports are stripped; `export default X` becomes `return X`; other
 * `export` keywords are dropped. Then the body is compiled as an async
 * function body. This catches syntax errors early; the real load still goes
 * through dynamic import (see bundle.ts), which is authoritative.
 */
export function syntaxGate(source: string): SafetyIssue | null {
  try {
    let body = source.replace(
      /(?:^|[;\n}])\s*import\s+(?:[\w$*\s{},]+?\s+from\s+)?["'][^"']+["']/g,
      "",
    );
    body = body.replace(/export\s+default\s+/g, "return ");
    body = body.replace(/export\s+(?=(?:const|let|var|function|class|async)\b)/g, "");
    const AsyncFunction = (async () => {}).constructor as typeof Function;
    new AsyncFunction(body); // compile only; never called
    return null;
  } catch (err) {
    return {
      kind: "syntax",
      message: `source failed compile check: ${(err as Error).message}`,
    };
  }
}

/** Validate a loaded default export satisfies ToolDefinition. */
export function validateToolShape(value: unknown, origin: string): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  if (value === null || typeof value !== "object") {
    return [{ kind: "shape", message: `${origin}: default export is not an object` }];
  }
  const tool = value as Partial<ToolDefinition>;
  if (!tool.name || typeof tool.name !== "string") {
    issues.push({ kind: "name", message: `${origin}: missing string "name"` });
  } else if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(tool.name)) {
    issues.push({ kind: "name", message: `${origin}: invalid tool name "${tool.name}"` });
  }
  const schema = tool.schema as ToolSchema | undefined;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    issues.push({ kind: "schema", message: `${origin}: missing "schema" object` });
  } else if (schema.type !== "object") {
    issues.push({
      kind: "schema",
      message: `${origin}: schema.type must be "object", got ${JSON.stringify(schema.type)}`,
    });
  }
  if (typeof tool.execute !== "function") {
    issues.push({ kind: "execute", message: `${origin}: missing "execute" function` });
  }
  return issues;
}

/** Full gate over raw tool source text. Run BEFORE writing/loading anything. */
export function checkToolSource(source: string, opts: SafetyOptions = {}): SafetyReport {
  const issues: SafetyIssue[] = [];
  for (const spec of extractImportSpecifiers(source)) {
    if (isBlockedSpecifier(spec, opts.allowModules ?? [])) {
      issues.push({
        kind: "import",
        message: `blocked import of "${spec}" (allow with allowModules option)`,
      });
    }
  }
  const syn = syntaxGate(source);
  if (syn) issues.push(syn);
  return { ok: issues.length === 0, issues };
}
