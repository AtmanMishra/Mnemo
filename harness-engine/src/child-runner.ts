/**
 * The bundle-side half of the execution boundary (issue #7).
 *
 * This file is the ONLY thing the agent's child process runs. It:
 *   1. reads one JSON request from stdin (the request contains the result path,
 *      which is why no path is passed on argv and none sits in the env — bundle
 *      code never gets to see where its verdict is written);
 *   2. chdir's to the bundle directory (the cwd jail) and re-runs the safety
 *      gate on every on-disk ref before importing it (the host gated the same
 *      bytes already; this second pass closes the gate->import TOCTOU window);
 *   3. imports the tool file(s), describes them, or runs one of them;
 *   4. writes a result FRAME to `resultPath` through a reference to
 *      `writeFileSync` captured BEFORE any bundle code is imported, then exits
 *      non-zero if the bundle failed.
 *
 * Why a file and not a stdout marker: stdout is the bundle's channel, and a
 * bundle that can print can print a fake frame. A path it cannot discover is a
 * channel it cannot forge. Anything the bundle prints stays on stdout/stderr,
 * where the host captures it (bounded) and reports it verbatim.
 *
 * The child is NOT a sandbox: it is the same user with the same filesystem and
 * network rights. See `boundary.ts` and the README for the honest list.
 */
import { promises as fs, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isWithin, checkToolSource, validateToolShape, type SafetyOptions } from "./safety.ts";
import type { ChildRequest, ChildResponse, ChildToolDescription } from "./boundary.ts";
import type { ToolDefinition } from "./types.ts";

/** Captured before any bundle code loads, so a patch to `node:fs` cannot reach it. */
const writeFrame = writeFileSync;

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** Where the verdict goes. Set as soon as the request is parsed. */
let resultPath: string | undefined;

function fail(message: string): void {
  if (resultPath) {
    try {
      writeFrame(resultPath, JSON.stringify({ ok: false, error: message }), "utf8");
    } catch { /* nothing more we can do; the host reports "no result frame" */ }
  }
  console.error(`[harness-boundary] ${message}`);
  process.exitCode = 1;
}

async function readRequest(): Promise<ChildRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("boundary request exceeded 8MiB");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChildRequest;
}

/** Gate + import one tool file, exactly as the host's gated load path does. */
async function loadTool(
  dir: string,
  ref: string,
  allowModules: string[] | undefined,
): Promise<ToolDefinition> {
  if (path.isAbsolute(ref) || ref.startsWith("~") || ref.split(/[\\/]+/).includes("..")) {
    throw new Error(`manifest tool ref "${ref}" must be relative and must not traverse`);
  }
  const lexical = path.resolve(dir, ref);
  if (!isWithin(dir, lexical)) throw new Error(`manifest tool ref "${ref}" resolves outside the bundle dir`);
  const fileAbs = await fs.realpath(lexical);
  if (!isWithin(dir, fileAbs)) {
    throw new Error(`manifest tool ref "${ref}" resolves outside the bundle dir (symlink escape)`);
  }
  const source = await fs.readFile(fileAbs, "utf8");
  const gateOpts: SafetyOptions = { allowModules, rootDir: dir, baseDir: path.dirname(fileAbs) };
  const report = checkToolSource(source, gateOpts);
  if (!report.ok) {
    throw new Error(
      `rejected by safety gate (child re-check): ${report.issues.map((i) => `[${i.kind}] ${i.message}`).join("; ")}`,
    );
  }
  const mod = (await import(pathToFileURL(fileAbs).href + `?boundary=${process.pid}-${Date.now()}`)) as {
    default?: unknown;
  };
  const shapeIssues = validateToolShape(mod?.default, ref);
  if (shapeIssues.length > 0) throw new Error(shapeIssues.map((i) => i.message).join("; "));
  return mod.default as ToolDefinition;
}

async function main(): Promise<void> {
  try {
    const request = await readRequest();
    resultPath = request.resultPath;
    const dir = await fs.realpath(path.resolve(request.dir));
    // cwd jail: the bundle's own directory, whatever the spawn inherited. The
    // REALPATH matters on Windows: a temp dir handed to us as an 8.3 short name
    // (C:\Users\ATMANM~1\...) would otherwise fail the containment check below
    // against the canonical paths the host checked.
    process.chdir(dir);
    // ...and step OUT of the jail on the way out. Windows keeps a directory
    // locked while any process has it as its cwd, so without this a bundle dir
    // could not be deleted (or rewritten by the watcher) right after a run,
    // even though the child was already gone.
    process.on("exit", () => {
      try { process.chdir(os.tmpdir()); } catch { /* already gone */ }
    });

    const base: ChildResponse = {
      ok: false,
      // NAMES ONLY: the child's own report of what the boundary handed it, so a
      // caller can audit the scrub without trusting bundle code or the host.
      envNames: Object.keys(process.env).sort(),
      cwd: process.cwd(),
      node: process.version,
    };

    if (request.mode === "describe") {
      const tools: ChildToolDescription[] = [];
      for (const ref of request.refs ?? []) {
        const tool = await loadTool(dir, ref, request.allowModules);
        tools.push({ ref, name: tool.name, description: tool.description, schema: tool.schema });
      }
      writeFrame(resultPath, JSON.stringify({ ...base, ok: true, tools }), "utf8");
      return;
    }

    if (request.mode === "execute") {
      const ref = request.refs?.[0];
      if (!ref) throw new Error("execute request needs a tool file ref");
      const tool = await loadTool(dir, ref, request.allowModules);
      if (request.tool && tool.name !== request.tool) {
        throw new Error(`bundle file ${ref} defines "${tool.name}", not "${request.tool}"`);
      }
      const value = await tool.execute((request.params ?? {}) as Record<string, unknown>);
      const result = typeof value === "string" ? value : JSON.stringify(value ?? null);
      writeFrame(resultPath, JSON.stringify({ ...base, ok: true, result }), "utf8");
      return;
    }

    throw new Error(`unknown boundary mode ${JSON.stringify((request as { mode?: string }).mode)}`);
  } catch (err: unknown) {
    fail(String((err as Error)?.stack ?? (err as Error)?.message ?? err));
  }
}

// A bundle that throws asynchronously after `execute` resolved must still leave
// a verdict behind, or the host can only say "no result frame".
process.on("unhandledRejection", (reason) => {
  fail(`unhandled rejection in the bundle process: ${String(reason)}`);
});
process.on("uncaughtException", (err) => {
  fail(`uncaught exception in the bundle process: ${err?.stack ?? err}`);
});

if (process.argv.includes("--boundary")) {
  await main();
}
