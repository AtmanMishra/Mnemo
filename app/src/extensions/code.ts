/**
 * The code index as tools: `code_search`, `code_symbol`, `code_refs`, `code_map`, and a line
 * after each edit naming the code elsewhere that calls what the edit changed.
 *
 * All four are read tools to the gate: they run without asking, plan mode included, because
 * the index is written under the Mnemo home and never in the project. They read no more than
 * `read` may: the index leaves out every file a read would be refused (credentials, and paths
 * a deny rule in permissions.json covers), and a `path` argument goes through the gate's path
 * checks like `read`'s does.
 *
 * Nothing is indexed until the agent first asks: opening Mnemo in a large folder costs
 * nothing until a code question is asked there. Even then, a folder that is likely not one
 * project (the home folder, one holding it, a drive's root, or more than MAX_FILES source
 * files) is not indexed unless the user says so with `/index on`; `/index off` turns the
 * index off for one project and deletes it. The choice is kept per project under the Mnemo
 * home, never in the project.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodeIndex, type Def, type Edge } from "../code/index.ts";
import { nativeSystem } from "../policy/paths.ts";
import { codeIndexPath } from "../runtime/paths.ts";
import type { Host } from "./host.ts";
import { denial, rulesOf, secretPath } from "./policy.ts";

const SOURCE_LINES = 80;
const IMPACT_LINES = 8;
const MAX_FILES = 10_000;

function realRoot(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

type Choice = "on" | "off";
const choicesFile = (home: string) => path.join(home, "index", "projects.json");

/** The user's `/index on|off` per project, by real path. */
export function indexChoices(home: string): Record<string, Choice> {
  try {
    return JSON.parse(fs.readFileSync(choicesFile(home), "utf8"));
  } catch {
    return {};
  }
}

function setIndexChoice(home: string, root: string, choice: Choice): void {
  const file = choicesFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ ...indexChoices(home), [root]: choice }, null, 2)}\n`, { mode: 0o600 });
}

/** Why a folder is likely not one project: the user's home, a folder holding it, or a drive's root. */
export function unlikelyProject(root: string, userHome: string): string | undefined {
  if (path.dirname(root) === root) return "it is the root of a drive";
  const rel = path.relative(root, userHome);
  if (rel === "") return "it is your home folder";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return "it holds your home folder";
  return undefined;
}

/** A path the model gave, as the index names it. Both sides are real paths, or Windows
 * 8.3 names and macOS /private/var make one file look outside the project. */
function relOf(root: string, cwd: string, file: string): string {
  return path.relative(root, realRoot(path.resolve(cwd, file))).split(path.sep).join("/");
}

const where = (d: Def) => `${d.path}:${d.line}`;
const head = (d: Def) => `${d.kind} ${d.qname}  ${where(d)}${d.endLine > d.line ? `-${d.endLine}` : ""}`;

/** The lines of a definition, read from disk now (the index keeps no file bodies). */
function sourceOf(root: string, d: Def): string {
  try {
    const lines = fs.readFileSync(path.join(root, d.path), "utf8").split("\n").slice(d.line - 1, d.endLine);
    const shown = lines.slice(0, SOURCE_LINES).map((l, i) => `${String(d.line + i).padStart(5)}  ${l}`);
    if (lines.length > SOURCE_LINES) shown.push(`       … ${lines.length - SOURCE_LINES} more lines (read ${d.path} for the rest)`);
    return shown.join("\n");
  } catch {
    return "";
  }
}

function edgeLine(e: Edge, side: "from" | "to"): string {
  const d = side === "from" ? e.from : e.to;
  const name = d ? d.qname : "(top level)";
  const verb = e.kind === "call" ? "" : ` ${e.kind}`;
  return `${name}${verb}  ${e.path}:${e.line}${e.confidence === "inferred" ? "  (inferred: the only definition of that name)" : ""}`;
}

export function codeExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    if (!host.settings.get().codeIndex) return;
    const indexes = new Map<string, CodeIndex>();
    const sys = nativeSystem();

    const indexFor = (root: string, maxFiles?: number): CodeIndex => {
      let ix = indexes.get(root);
      if (!ix) {
        const rules = rulesOf(host);
        ix = new CodeIndex(codeIndexPath(host.home, root), root, {
          exclude: (rel) => secretPath(host, root, rel, sys) || denial(rules, root, "read", { path: rel }, sys) !== undefined,
          maxFiles,
        });
        indexes.set(root, ix);
      }
      return ix;
    };
    const close = (root: string) => {
      indexes.get(root)?.close();
      indexes.delete(root);
    };
    const drop = (root: string) => {
      close(root);
      try {
        fs.rmSync(path.dirname(codeIndexPath(host.home, root)), { recursive: true, force: true });
      } catch {
        // another agent on this project still has it open (Windows): it goes with the next /index off
      }
    };
    const elsewise = "Use grep, find and read instead";
    /** The index for this project, brought up to date, or why there is none. */
    const fresh = async (cwd: string): Promise<CodeIndex | string> => {
      const root = realRoot(cwd);
      const choice = indexChoices(host.home)[root];
      if (choice === "off") return `The code index is off for this project (the user turned it off with /index off). ${elsewise}.`;
      const why = choice === "on" ? undefined : unlikelyProject(root, realRoot(os.homedir()));
      const anyway = "If it is one, the user can index it anyway with /index on.";
      if (why) return `Not indexing ${root}: ${why}, so it is likely not one project. ${elsewise}. ${anyway}`;
      const ix = indexFor(root, choice === "on" ? undefined : MAX_FILES);
      const r = await ix.refresh();
      if (r.tooMany) {
        drop(root);
        return `Not indexing ${root}: it has ${r.tooMany} source files (more than ${MAX_FILES}), so it is likely not one project. ${elsewise}. ${anyway}`;
      }
      return ix;
    };
    const text = (body: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: body }], details });
    const notFound = (ix: CodeIndex, name: string) =>
      text(`No definition named ${name} in the index (${ix.files()} files). Try code_search with words from it, or grep.`);

    pi.registerTool(
      defineTool({
        name: "code_search",
        label: "Code search",
        description:
          "Find definitions (functions, methods, classes, types) in this project by name or by words about them, ranked. " +
          "Returns kind, name, file:line and signature. Prefer it over grep to find where something is defined; use grep for text inside bodies.",
        parameters: Type.Object({
          query: Type.String({ description: "Identifiers or plain words, e.g. 'retry backoff' or 'parseConfig'" }),
          k: Type.Optional(Type.Number({ description: "How many results (default 10)" })),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          const ix = await fresh(ctx.cwd);
          if (typeof ix === "string") return text(ix);
          const hits = ix.search(params.query, Math.min(Math.max(params.k ?? 10, 1), 50));
          if (!hits.length) return text(`Nothing in the index matches "${params.query}" (${ix.files()} files indexed). Try other words, or grep.`);
          return text(hits.map((d) => `${head(d)}\n    ${d.signature}`).join("\n"), { hits: hits.length });
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "code_symbol",
        label: "Code symbol",
        description:
          "Show a definition: its signature, members and source. name: 'Cache.get', 'get', or 'src/cache.ts#Cache.get'. " +
          "With only path: every signature in that file without bodies (its outline).",
        parameters: Type.Object({
          name: Type.Optional(Type.String({ description: "The symbol" })),
          path: Type.Optional(Type.String({ description: "A file in this project; alone, its outline" })),
          source: Type.Optional(Type.Boolean({ description: "Include the source (default true)" })),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          const ix = await fresh(ctx.cwd);
          if (typeof ix === "string") return text(ix);
          const rel = params.path ? relOf(ix.root, ctx.cwd, params.path) : undefined;
          if (!params.name) {
            if (!rel) return text("Give a name, or a path for that file's outline.");
            const defs = ix.fileDefs(rel);
            if (!defs.length) return text(`No definitions indexed in ${rel}.`);
            const depth = (d: Def) => (d.parent ? d.qname.split(".").length - 1 : 0);
            return text(defs.map((d) => `${"  ".repeat(depth(d))}${d.line}: ${d.signature}`).join("\n"), { defs: defs.length });
          }
          let defs = ix.lookup(rel ? `${rel}#${params.name}` : params.name);
          if (!defs.length) return notFound(ix, params.name);
          defs = defs.slice(0, 5);
          const withSource = params.source !== false && defs.length <= 3;
          const parts = defs.map((d) => {
            const members = ix.fileDefs(d.path).filter((m) => m.parent === d.qname);
            const lines = [head(d), `    ${d.signature}`];
            if (members.length) lines.push(`    members: ${members.map((m) => m.name).join(", ")}`);
            if (withSource) lines.push(sourceOf(ix.root, d));
            return lines.join("\n");
          });
          return text(parts.join("\n\n"), { defs: defs.length });
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "code_refs",
        label: "Code references",
        description:
          "Who calls a definition (callers; for a type, also who extends or implements it), or what it calls (callees). " +
          "depth > 1 follows callers of callers: what a change can break. Each link is exact (same file, an import, or a typed receiver) " +
          "or marked inferred; calls the index cannot tie to one definition are counted, not guessed.",
        parameters: Type.Object({
          name: Type.String({ description: "The symbol: 'Cache.get', 'get', or 'src/cache.ts#Cache.get'" }),
          direction: Type.Optional(Type.Union([Type.Literal("callers"), Type.Literal("callees")])),
          depth: Type.Optional(Type.Number({ description: "1 to 3 (default 1)" })),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          const ix = await fresh(ctx.cwd);
          if (typeof ix === "string") return text(ix);
          const roots = ix.lookup(params.name).slice(0, 3);
          if (!roots.length) return notFound(ix, params.name);
          const depth = Math.min(Math.max(Math.trunc(params.depth ?? 1), 1), 3);
          const callees = params.direction === "callees";
          const out: string[] = [];
          for (const root of roots) {
            out.push(`${head(root)}${callees ? " calls:" : " is used by:"}`);
            const seen = new Set([root.id]);
            let level = [root];
            for (let d = 1; d <= depth && level.length; d++) {
              const next: Def[] = [];
              for (const def of level) {
                const indent = "  ".repeat(d);
                if (callees) {
                  const r = ix.callees(def);
                  for (const e of r.edges) {
                    out.push(`${indent}${edgeLine(e, "to")}`);
                    if (!seen.has(e.to.id)) next.push(e.to), seen.add(e.to.id);
                  }
                  if (d === 1 && r.untied.length) out.push(`${indent}not in this project or not tied: ${r.untied.slice(0, 20).join(", ")}`);
                } else {
                  const r = ix.callers(def);
                  for (const e of r.edges) {
                    out.push(`${indent}${edgeLine(e, "from")}`);
                    if (e.from && !seen.has(e.from.id)) next.push(e.from), seen.add(e.from.id);
                  }
                  if (r.untied) out.push(`${indent}+ ${r.untied} call${r.untied === 1 ? "" : "s"} to a ${def.name} the index could not tie to one definition (grep finds them)`);
                }
                if (out.length > 300) break;
              }
              level = next;
            }
            if (out[out.length - 1]?.endsWith(":")) out.push("  nothing found");
          }
          return text(out.slice(0, 300).join("\n"), { lines: out.length });
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "code_map",
        label: "Code map",
        description: "A first look at this project, or a folder of it: folders with their file and definition counts, and the most-used definitions.",
        parameters: Type.Object({ path: Type.Optional(Type.String({ description: "A folder in this project (default: all of it)" })) }),
        async execute(_id, params, _signal, _update, ctx) {
          const ix = await fresh(ctx.cwd);
          if (typeof ix === "string") return text(ix);
          const rel = params.path ? relOf(ix.root, ctx.cwd, params.path) : "";
          const m = ix.map(rel);
          if (!m.dirs.length) return text(`Nothing indexed under ${rel || "this project"}.`);
          const lines = [`${ix.files()} files indexed`, "", ...m.dirs.slice(0, 30).map((d) => `${d.dir}/  ${d.files} files, ${d.defs} definitions`)];
          if (m.hubs.length) lines.push("", "most used:", ...m.hubs.map((h) => `  ${h.def.qname}  ${where(h.def)}  ${h.uses} uses`));
          return text(lines.join("\n"));
        },
      }),
    );

    // After an edit: what calls the definitions it changed, from elsewhere. Only once the
    // index exists, so a project nobody asked a code question in is never indexed for this.
    pi.on("tool_result", async (event, ctx) => {
      if ((event.toolName !== "edit" && event.toolName !== "write") || event.isError || !host.settings.get().codeImpact) return;
      const file = event.input.path;
      if (typeof file !== "string") return;
      const root = realRoot(ctx.cwd);
      const ix = indexes.get(root);
      if (!ix || ix.files() === 0 || indexChoices(host.home)[root] === "off") return;
      const rel = relOf(ix.root, ctx.cwd, file);
      if (rel.startsWith("..")) return;
      try {
        const before = ix.fileDefs(rel);
        await ix.refreshFile(rel);
        const after = new Map(ix.fileDefs(rel).map((d) => [d.qname, d]));
        // Changed in place; a definition that is gone has nothing left to tie its callers to.
        const changed = before.map((b) => after.get(b.qname)).filter((a, i): a is Def => a !== undefined && a.hash !== before[i]!.hash && a.kind !== "module");
        const lines: string[] = [];
        for (const d of changed.slice(0, 5))
          for (const e of ix.callers(d).edges) if (e.path !== rel && lines.length < IMPACT_LINES) lines.push(`  ${d.qname} ← ${edgeLine(e, "from")}`);
        if (!lines.length) return;
        const note = `\n\nThis edit changed definitions that other code calls (check they still fit):\n${lines.join("\n")}`;
        return { content: [...event.content, { type: "text" as const, text: note }] };
      } catch {
        return;
      }
    });

    pi.registerCommand("index", {
      description: "the code index for this project: /index on · /index off (deletes it) · /index alone says which",
      handler: async (args, ctx) => {
        const root = realRoot(ctx.cwd);
        const arg = args.trim();
        if (arg === "on" || arg === "off") {
          setIndexChoice(host.home, root, arg);
          if (arg === "off") drop(root);
          else close(root); // reopened without the size limit
          ctx.ui.notify(
            arg === "on"
              ? `Code index on for ${root}. It is built the first time the agent asks a code question here.`
              : `Code index off for ${root}, and its index deleted. The agent uses grep, find and read here; /index on turns it back on.`,
            "info",
          );
          return;
        }
        if (arg) {
          ctx.ui.notify("Usage: /index · /index on · /index off", "warning");
          return;
        }
        const choice = indexChoices(host.home)[root];
        const why = unlikelyProject(root, realRoot(os.homedir()));
        const n = indexes.get(root)?.files();
        const files = n ? `${n} file${n === 1 ? "" : "s"} indexed` : undefined;
        ctx.ui.notify(
          choice === "off"
            ? `Code index off for ${root} (/index on turns it on).`
            : choice === "on"
              ? `Code index on for ${root}${files ? `: ${files}` : ""}.`
              : why
                ? `Code index not used in ${root}: ${why}. /index on indexes it anyway.`
                : `Code index on for ${root}${files ? `: ${files}` : ", built when the agent first asks a code question"}. /index off turns it off here; a folder with more than ${MAX_FILES} source files is left alone unless you say /index on.`,
          "info",
        );
      },
    });

    pi.on("session_shutdown", async () => {
      for (const ix of indexes.values()) ix.close();
      indexes.clear();
    });
  };
}
