/**
 * The languages the code index reads, and their grammars.
 *
 * The grammars are tree-sitter compiled to WebAssembly (`@vscode/tree-sitter-wasm`), embedded
 * in the binary with `type: "file"` so a compiled `mnemo` carries them. WebAssembly rather than
 * native addons: a native `.node` file does not survive `bun build --compile`, and this way the
 * index needs no compiler on any of the five release platforms.
 */
import { Language, Parser } from "@vscode/tree-sitter-wasm";
import coreWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm" with { type: "file" };
import goWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm" with { type: "file" };
import jsWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import pyWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" with { type: "file" };
import rustWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm" with { type: "file" };
import tsxWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import tsWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };

export type LangId = "typescript" | "tsx" | "javascript" | "python" | "rust" | "go";

const BY_EXT: Record<string, LangId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
};

const WASM: Record<LangId, string> = { typescript: tsWasm, tsx: tsxWasm, javascript: jsWasm, python: pyWasm, rust: rustWasm, go: goWasm };

export function langOf(file: string): LangId | undefined {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? undefined : BY_EXT[file.slice(dot).toLowerCase()];
}

/**
 * Languages whose code can call each other's. A call is never tied to a definition in another
 * family: a Go `make(...)` is not a call to a TypeScript function named `make`.
 */
export function familyOf(lang: LangId): string {
  return lang === "typescript" || lang === "tsx" || lang === "javascript" ? "js" : lang;
}

let ready: Promise<Map<LangId, Parser>> | undefined;

/** One parser per language, loaded once per process. */
export function parsers(): Promise<Map<LangId, Parser>> {
  ready ??= (async () => {
    await Parser.init({ locateFile: () => coreWasm });
    const out = new Map<LangId, Parser>();
    for (const [id, file] of Object.entries(WASM) as [LangId, string][]) {
      const parser = new Parser();
      parser.setLanguage(await Language.load(file));
      out.set(id, parser);
    }
    return out;
  })();
  return ready;
}
