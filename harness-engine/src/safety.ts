/**
 * Safety gate for LLM-generated tool source.
 *
 * What this DOES:
 *  - scans static imports, dynamic import(), and require() specifiers —
 *    INCLUDING backtick template literals and nested expressions
 *  - rejects blocked modules ('fs', 'child_process', 'net', 'http', ...) unless
 *    explicitly allowlisted
 *  - rejects ANY import()/require() with a NON-literal specifier (variable,
 *    concatenation, join()) — those cannot be verified, so they are unsafe
 *  - rejects `process.*` / `globalThis.process` access outright
 *  - confines relative imports to the bundle dir and scans the imported
 *    file's source too (depth-capped), when the gate knows the bundle root
 *  - enforces a syntactically plausible module via an AsyncFunction compile
 *    check (ESM import/export lines are stripped/transformed first)
 *  - validates the shape of a loaded ToolDefinition (schema present, execute
 *    fn) — this runs in bundle.ts after import
 *
 * What this does NOT do (be honest with yourself):
 *  - it is NOT a sandbox. Once a bundle is registered, execute() runs with full
 *    Node.js privileges inside this process. The gate only filters what gets
 *    loaded; it cannot stop a loaded tool from indirect escapes (prototype
 *    pollution, infinite loops, network via the global fetch()).
 *  - string concatenation inside eval/Function bodies can still hide things
 *    the scanner cannot see. Non-literal module requests are therefore
 *    rejected outright rather than "checked".
 * For real isolation, run tools in a worker/child with restricted permissions
 * (e.g. node --permission) or in a container. See README "Security notes".
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ToolDefinition, ToolSchema } from "./types.ts";

const DEFAULT_BLOCKED = new Set([
  "child_process",
  "fs",
  "fs/promises",
  // net-class + host-info modules: blocked by default (audit 12.2). Allow
  // case-by-case with the allowModules option at the engine API level.
  "http",
  "https",
  "net",
  "tls",
  "dns",
  "os",
  "process",
]);

/** Default cap on how deep relative-import chains are followed. */
export const DEFAULT_MAX_IMPORT_DEPTH = 3;

export interface SafetyOptions {
  /** Module specifiers that may bypass the blocklist, e.g. ["node:fs"]. Compared normalized. */
  allowModules?: string[];
  /**
   * Bundle root directory. When set (load-time gate), relative imports are
   * resolved against baseDir, must stay INSIDE rootDir, and the target
   * file's source is scanned recursively (depth-capped, cycle-guarded).
   * When unset (pre-write string gate, e.g. createHarness), relative
   * imports cannot be resolved yet and are DEFERRED to the load-time gate;
   * absolute imports are rejected either way.
   */
  rootDir?: string;
  /** Directory of the file the source belongs to (defaults to rootDir). */
  baseDir?: string;
  /** Max relative-import chain depth. Default 3. */
  maxImportDepth?: number;
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
  return spec.startsWith("node:") ? spec.slice(5) : spec;
}

/** True if `target` is inside (or equal to) `root`, lexically. */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Static `import ... from "m"` clauses. */
const STATIC_IMPORT_RE =
  /(?:^|[;\n}])\s*import\s+(?:[\w$*\s{},]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g;
/** `import(` / `require(` call sites (argument scanned separately). */
const DYNAMIC_REQUEST_RE = /\b(?:import|require)\s*\(/g;

/**
 * Direct use of the global `process` identifier — bare reference or property
 * access — but NOT `foo.process` (member of another object, not the global)
 * and NOT a module specifier (`"process"` / `node:process` — those are the
 * blocklist's job, allowlistable via allowModules).
 */
const PROCESS_ACCESS_RE = /(?:^|[^\w$.:'"`\]])process\b/;
const GLOBAL_PROCESS_RE = /\bglobalThis\s*\.\s*process\b/;

function isRelativeSpec(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/");
}

function isAbsoluteSpec(spec: string): boolean {
  return spec.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(spec);
}

/**
 * Parse a dynamic import()/require() argument as a LITERAL module specifier.
 * Accepts quoted strings and backtick templates WITHOUT interpolation.
 * Returns null for anything else (variable, concatenation, join(), ...).
 */
function parseLiteralSpec(arg: string): string | null {
  const a = arg.trim();
  if (/^"[^"]*"$/.test(a) || /^'[^']*'$/.test(a)) return a.slice(1, -1);
  const bt = /^`([^`]*)`$/.exec(a);
  if (bt && !bt[1]!.includes("${")) return bt[1]!;
  return null;
}

/**
 * Scan every `import(...)` / `require(...)` call site, honoring nested
 * parens/brackets and string bodies, and split the arguments into literal
 * specifiers vs non-literal (unverifiable) expressions.
 */
export function scanDynamicRequests(
  source: string,
): { literals: string[]; nonLiteral: string[] } {
  const literals = new Set<string>();
  const nonLiteral: string[] = [];
  const re = DYNAMIC_REQUEST_RE;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    // Walk to the matching close paren, skipping string/template bodies.
    let depth = 1;
    let i = re.lastIndex;
    let closed = false;
    for (; i < source.length; i++) {
      const c = source[i]!;
      if (c === '"' || c === "'" || c === "`") {
        i++;
        while (i < source.length && source[i] !== c) {
          if (source[i] === "\\") i++;
          i++;
        }
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          closed = true;
          break;
        }
      }
    }
    if (!closed) continue; // malformed; the syntax gate will catch it
    const arg = source.slice(re.lastIndex, i).trim();
    const lit = parseLiteralSpec(arg);
    if (lit !== null) literals.add(lit);
    else nonLiteral.push(arg);
  }
  return { literals: [...literals], nonLiteral };
}

/** Extract every plausible module specifier from a source string. */
export function extractImportSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  let m: RegExpExecArray | null;
  const staticRe = new RegExp(STATIC_IMPORT_RE.source, STATIC_IMPORT_RE.flags);
  while ((m = staticRe.exec(source))) specs.add(m[1]!);
  for (const lit of scanDynamicRequests(source).literals) specs.add(lit);
  return [...specs];
}

export function isBlockedSpecifier(
  spec: string,
  allowModules: readonly string[] = [],
): boolean {
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

/**
 * Full gate over raw tool source text. Run BEFORE writing/loading anything.
 *
 * Without `rootDir` this is the string-level gate (createHarness pre-write):
 * relative imports are deferred to the load-time gate, everything else is
 * enforced. With `rootDir` (loadBundle) relative imports are resolved,
 * confined to the bundle dir, and their targets scanned recursively.
 */
export function checkToolSource(source: string, opts: SafetyOptions = {}): SafetyReport {
  const issues = gateSource(source, opts, 0, new Set());
  return { ok: issues.length === 0, issues };
}

function gateSource(
  source: string,
  opts: SafetyOptions,
  depth: number,
  visited: Set<string>,
): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  const allow = opts.allowModules ?? [];
  const maxDepth = opts.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH;

  // Static + dynamic-literal specifiers, one pass.
  const specs = new Set(extractImportSpecifiers(source));

  // Non-literal dynamic requests: unverifiable => rejected (hard ceiling).
  for (const arg of scanDynamicRequests(source).nonLiteral) {
    issues.push({
      kind: "import",
      message:
        `non-literal module specifier in import/require(${arg}) cannot be verified; ` +
        `rejected (allowlist a literal specifier instead)`,
    });
  }

  for (const spec of specs) {
    if (isAbsoluteSpec(spec)) {
      issues.push({
        kind: "import",
        message: `absolute import "${spec}" rejected: bundles must be self-contained`,
      });
      continue;
    }
    if (isRelativeSpec(spec)) {
      if (!opts.rootDir) continue; // string-level gate: deferred to load-time
      const base = opts.baseDir ?? opts.rootDir;
      const target = path.resolve(base, spec);
      if (!isWithin(opts.rootDir, target)) {
        issues.push({
          kind: "import",
          message: `relative import "${spec}" resolves outside the bundle directory`,
        });
        continue;
      }
      if (depth >= maxDepth) {
        issues.push({
          kind: "import",
          message: `relative import chain exceeds depth cap ${maxDepth} ("${spec}")`,
        });
        continue;
      }
      if (visited.has(target)) continue; // cycle guard: already scanned
      visited.add(target);
      let depSource: string;
      try {
        depSource = readFileSync(target, "utf8");
      } catch {
        issues.push({
          kind: "import",
          message: `relative import "${spec}" target is missing or unreadable`,
        });
        continue;
      }
      issues.push(
        ...gateSource(
          depSource,
          { ...opts, baseDir: path.dirname(target) },
          depth + 1,
          visited,
        ),
      );
      continue;
    }
    if (isBlockedSpecifier(spec, allow)) {
      issues.push({
        kind: "import",
        message: `blocked import of "${spec}" (allow with allowModules option)`,
      });
    }
  }

  // process access — bare identifier, property access, or globalThis.process —
  // even without any import. The `node:process` module import itself is
  // governed by the blocklist (allowlistable), not by this rule.
  if (PROCESS_ACCESS_RE.test(source) || GLOBAL_PROCESS_RE.test(source)) {
    issues.push({
      kind: "import",
      message: "direct process/globalThis.process access is blocked by default",
    });
  }

  const syn = syntaxGate(source);
  if (syn) issues.push(syn);
  return issues;
}
