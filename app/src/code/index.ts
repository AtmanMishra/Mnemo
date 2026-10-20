/**
 * The code index: every definition in a project and what each one calls, imports, extends
 * and implements, in one SQLite file under the Mnemo home (never in the project).
 *
 * Freshness is the index's own job. Every query first stats the project's files against
 * what the index last read, and re-reads only the files whose size or mtime moved (and
 * re-parses only those whose bytes did), so an answer describes the code as it is now:
 * the agent's edits, the user's editor and a branch switch alike.
 *
 * Definitions are stored as extracted; references are stored as names and tied to a
 * definition at query time, so a changed file never leaves a stale edge behind elsewhere.
 * A reference is tied only when the code says which definition it means:
 *   exact     same file, an imported file, or a receiver whose type was written down
 *   inferred  the only definition of that name in the language family
 * Anything else stays untied and is counted, never guessed.
 *
 * What it never holds: file bodies (snippets are read from disk when asked for), files a
 * read tool may not read (the caller's `exclude`), files over 1 MiB, and binary files.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { redact } from "@mnemo/memory";
import { listFiles } from "../ui/files.ts";
import { extract, type Definition, type SymbolKind } from "./extract.ts";
import { familyOf, langOf, parsers, type LangId } from "./languages.ts";

/** Bump when the tables or what the extractor writes into them change: the index is rebuilt. */
const SCHEMA = "1";
const MAX_BYTES = 1024 * 1024;

export type Confidence = "exact" | "inferred";

export interface Def extends Definition {
  id: number;
  path: string;
}

export interface Edge {
  /** The definition the call sits in; undefined for a call at the top of a file. */
  from?: Def;
  to: Def;
  path: string;
  line: number;
  kind: "call" | "extends" | "implements";
  confidence: Confidence;
}

interface RefRow {
  path: string;
  src: string;
  kind: string;
  name: string;
  recv: string;
  member: number;
  line: number;
}

export interface RefreshResult {
  read: number;
  removed: number;
  files: number;
  /** Set, and nothing read, when the project has more source files than `maxFiles`. */
  tooMany?: number;
}

export interface CodeIndexOptions {
  /** A project-relative path (with `/`) the index must not read: credentials, denied paths. */
  exclude?: (rel: string) => boolean;
  /** The project's files, relative with `/`; tests inject them, the default asks git. */
  list?: (root: string) => string[];
  /** More source files than this and a refresh reads none: the folder is likely not one project. */
  maxFiles?: number;
}

const CALLABLE: SymbolKind[] = ["function", "method", "class", "struct", "enum", "type", "interface", "trait"];
const TYPES: SymbolKind[] = ["class", "interface", "struct", "trait", "enum", "type"];

/** `getUserName` and `get_user_name` → `get user name`: what a search word is matched against. */
export function words(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .join(" ");
}

export class CodeIndex {
  readonly root: string;
  private readonly db: Database;
  private readonly exclude: (rel: string) => boolean;
  private readonly list: (root: string) => string[];
  private readonly maxFiles: number;
  /** Files each file imports, rebuilt after a refresh changes anything. */
  private importsOf?: Map<string, Set<string>>;

  constructor(file: string, root: string, o: CodeIndexOptions = {}) {
    this.root = root;
    this.exclude = o.exclude ?? (() => false);
    this.list = o.list ?? listFiles;
    this.maxFiles = o.maxFiles ?? Number.POSITIVE_INFINITY;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // a platform without modes keeps its own access rules
    }
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 3000");
    this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const version = this.db.query("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | null;
    if (version?.value !== SCHEMA) {
      for (const t of ["files", "defs", "refs", "defs_fts"]) this.db.run(`DROP TABLE IF EXISTS ${t}`);
      this.db.run("INSERT OR REPLACE INTO meta VALUES ('schema', ?)", [SCHEMA]);
    }
    this.db.run("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, mtime REAL, hash TEXT, lang TEXT)");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS defs (id INTEGER PRIMARY KEY, path TEXT, qname TEXT, name TEXT, kind TEXT, parent TEXT, line INTEGER, end_line INTEGER, signature TEXT, exported INTEGER, hash TEXT)",
    );
    this.db.run("CREATE INDEX IF NOT EXISTS defs_name ON defs (name)");
    this.db.run("CREATE INDEX IF NOT EXISTS defs_path ON defs (path)");
    this.db.run("CREATE TABLE IF NOT EXISTS refs (path TEXT, src TEXT, kind TEXT, name TEXT, recv TEXT, member INTEGER, line INTEGER)");
    this.db.run("CREATE INDEX IF NOT EXISTS refs_name ON refs (name, kind)");
    this.db.run("CREATE INDEX IF NOT EXISTS refs_src ON refs (path, src)");
    this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS defs_fts USING fts5(words, signature, path)");
  }

  close(): void {
    this.db.close();
  }

  /** Bring the index up to date with the files on disk. */
  async refresh(): Promise<RefreshResult> {
    const known = new Map(
      (this.db.query("SELECT path, size, mtime, hash FROM files").all() as { path: string; size: number; mtime: number; hash: string }[]).map((r) => [r.path, r]),
    );
    const wanted = this.list(this.root).filter((f) => langOf(f) && !this.exclude(f));
    if (wanted.length > this.maxFiles) return { read: 0, removed: 0, files: 0, tooMany: wanted.length };
    const seen = new Set<string>();
    let read = 0;
    let ps: Awaited<ReturnType<typeof parsers>> | undefined;
    for (const rel of wanted) {
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(this.root, rel));
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      seen.add(rel);
      const k = known.get(rel);
      if (k && k.size === st.size && k.mtime === st.mtimeMs) continue;
      ps ??= await parsers();
      if (this.readFile(rel, st, ps, k?.hash) && ++read % 25 === 0) await new Promise((r) => setTimeout(r, 0)); // let the interface draw
    }
    let removed = 0;
    for (const rel of known.keys())
      if (!seen.has(rel)) {
        this.forget(rel);
        removed++;
      }
    if (read || removed) this.importsOf = undefined;
    return { read, removed, files: seen.size };
  }

  /** Re-read one file now (after an edit), whatever its mtime says. */
  async refreshFile(rel: string): Promise<void> {
    const lang = langOf(rel);
    if (!lang || this.exclude(rel)) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(this.root, rel));
    } catch {
      this.forget(rel);
      this.importsOf = undefined;
      return;
    }
    if (!st.isFile() || st.size > MAX_BYTES) return;
    if (this.readFile(rel, st, await parsers())) this.importsOf = undefined;
  }

  /** Parse and store one file; false when its bytes had not changed. */
  private readFile(rel: string, st: fs.Stats, ps: Map<LangId, import("@vscode/tree-sitter-wasm").Parser>, oldHash?: string): boolean {
    const lang = langOf(rel)!;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(this.root, rel));
    } catch {
      return false;
    }
    const hash = Bun.hash(bytes).toString(36);
    if (hash === oldHash) {
      this.db.run("UPDATE files SET size = ?, mtime = ? WHERE path = ?", [st.size, st.mtimeMs, rel]);
      return false;
    }
    const binary = bytes.subarray(0, 8192).includes(0);
    const found = binary ? { definitions: [], references: [] } : extract(ps.get(lang)!, lang, bytes.toString("utf8"));
    const insDef = this.db.prepare("INSERT INTO defs (path, qname, name, kind, parent, line, end_line, signature, exported, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insFts = this.db.prepare("INSERT INTO defs_fts (rowid, words, signature, path) VALUES (?, ?, ?, ?)");
    const insRef = this.db.prepare("INSERT INTO refs (path, src, kind, name, recv, member, line) VALUES (?, ?, ?, ?, ?, ?, ?)");
    try {
      this.db.transaction(() => {
        this.forget(rel);
        this.db.run("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)", [rel, st.size, st.mtimeMs, hash, lang]);
        for (const d of found.definitions) {
          const signature = redact(d.signature);
          const r = insDef.run(rel, d.qname, d.name, d.kind, d.parent, d.line, d.endLine, signature, d.exported ? 1 : 0, d.hash);
          insFts.run(r.lastInsertRowid, `${words(d.qname)} ${d.name.toLowerCase()}`, signature, words(rel));
        }
        for (const x of found.references) insRef.run(rel, x.from, x.kind, x.name, x.recvType, x.member ? 1 : 0, x.line);
      })();
    } finally {
      // A statement left unfinalized keeps the database file open after close(), and Windows will not delete an open file.
      insDef.finalize();
      insFts.finalize();
      insRef.finalize();
    }
    return true;
  }

  private forget(rel: string): void {
    this.db.run("DELETE FROM defs_fts WHERE rowid IN (SELECT id FROM defs WHERE path = ?)", [rel]);
    this.db.run("DELETE FROM defs WHERE path = ?", [rel]);
    this.db.run("DELETE FROM refs WHERE path = ?", [rel]);
    this.db.run("DELETE FROM files WHERE path = ?", [rel]);
  }

  // ── queries ───────────────────────────────────────────────────────────────

  private defs(sql: string, params: (string | number)[] = []): Def[] {
    return (this.db.query(`SELECT * FROM defs ${sql}`).all(...params) as Record<string, unknown>[]).map(rowDef);
  }

  def(id: number): Def | undefined {
    return this.defs("WHERE id = ?", [id])[0];
  }

  /** Every definition in a file, in line order. */
  fileDefs(rel: string): Def[] {
    return this.defs("WHERE path = ? ORDER BY line", [rel]);
  }

  files(): number {
    return (this.db.query("SELECT count(*) AS n FROM files").get() as { n: number }).n;
  }

  /** Definitions a name means: `Cache.get`, `get`, or `src/cache.ts#Cache.get`. */
  lookup(name: string): Def[] {
    const hash = name.indexOf("#");
    if (hash > 0) return this.defs("WHERE path = ? AND (qname = ? OR name = ?) ORDER BY line", [name.slice(0, hash), name.slice(hash + 1), name.slice(hash + 1)]);
    const exact = this.defs("WHERE qname = ? ORDER BY path, line", [name]);
    if (exact.length) return exact;
    const last = name.split(/::|\./).pop() ?? name;
    const byName = this.defs("WHERE name = ? ORDER BY path, line", [last]);
    return last === name ? byName : byName.filter((d) => d.qname.endsWith(name));
  }

  /** Definitions ranked for plain words or identifiers: BM25, nudged towards what is used. */
  search(query: string, k = 10): Def[] {
    const terms = [...new Set(words(query).split(" ").filter(Boolean))];
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(" OR ");
    const rows = this.db
      .query("SELECT d.*, bm25(defs_fts, 10.0, 2.0, 1.0) AS rank FROM defs_fts JOIN defs d ON d.id = defs_fts.rowid WHERE defs_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(match, k * 5) as (Record<string, unknown> & { rank: number })[];
    const uses = this.db.prepare("SELECT count(*) AS n FROM refs WHERE name = ? AND kind != 'import'");
    const ranked = rows.map((r) => {
        const d = rowDef(r);
        const n = (uses.get(d.name) as { n: number }).n;
        // bm25 is negative, lower is better; a used, exported definition is the likelier answer.
        // Asking for a name by its name finds that definition first.
        const named = d.name.toLowerCase() === query.trim().toLowerCase() || d.qname.toLowerCase() === query.trim().toLowerCase();
        return { d, score: -r.rank + 0.4 * Math.log1p(n) + (d.exported ? 0.3 : 0) + (named ? 100 : 0) };
      });
    uses.finalize();
    return ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => s.d);
  }

  /** Who calls `to` (and, for a type, who extends or implements it). */
  callers(to: Def): { edges: Edge[]; untied: number } {
    const imports = this.imports();
    const edges: Edge[] = [];
    let untied = 0;
    const rows = this.db.query("SELECT * FROM refs WHERE name = ? AND kind != 'import'").all(to.name) as RefRow[];
    for (const r of rows) {
      if (r.kind !== "call" && !TYPES.includes(to.kind)) continue;
      if (familyOf(langOf(r.path)!) !== familyOf(langOf(to.path)!)) continue;
      if (r.kind === "call") {
        const tied = this.tie(r, imports);
        const hit = tied.find((t) => t.def.id === to.id);
        if (hit) edges.push({ from: this.owner(r), to, path: r.path, line: r.line, kind: "call", confidence: hit.confidence });
        else if (!tied.length) untied++;
      } else {
        const same = r.path === to.path || imports.get(r.path)?.has(to.path);
        const many = this.defs("WHERE name = ? AND kind IN ('class','interface','struct','trait','type','enum')", [to.name]).filter((d) => familyOf(langOf(d.path)!) === familyOf(langOf(r.path)!));
        if (same || many.length === 1)
          edges.push({ from: this.ownerOrType(r), to, path: r.path, line: r.line, kind: r.kind as "extends" | "implements", confidence: same ? "exact" : "inferred" });
        else untied++;
      }
    }
    edges.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return { edges, untied };
  }

  /** What `from` calls: tied calls, and the names it calls that tie to nothing here. */
  callees(from: Def): { edges: Edge[]; untied: string[] } {
    const imports = this.imports();
    const rows = this.db.query("SELECT * FROM refs WHERE path = ? AND src = ? AND kind = 'call' ORDER BY line").all(from.path, from.qname) as RefRow[];
    const edges: Edge[] = [];
    const untied = new Set<string>();
    for (const r of rows) {
      const tied = this.tie(r, imports);
      if (!tied.length) untied.add(r.recv ? `${r.recv}.${r.name}` : r.name);
      for (const t of tied) edges.push({ from, to: t.def, path: r.path, line: r.line, kind: "call", confidence: t.confidence });
    }
    return { edges, untied: [...untied] };
  }

  /** The definition a reference sits in. */
  private owner(r: RefRow): Def | undefined {
    return r.src ? this.defs("WHERE path = ? AND qname = ?", [r.path, r.src])[0] : undefined;
  }

  /** Rust's `impl Trait for Type` sits in no definition: the type stands in for it. */
  private ownerOrType(r: RefRow): Def | undefined {
    return this.owner(r) ?? (r.src ? this.defs("WHERE name = ? AND kind IN ('struct','enum','class')", [r.src])[0] : undefined);
  }

  /** The definitions a call means, when the code says which; empty when it does not. */
  private tie(r: RefRow, imports: Map<string, Set<string>>): { def: Def; confidence: Confidence }[] {
    const family = familyOf(langOf(r.path)!);
    const cands = this.defs(`WHERE name = ? AND kind IN (${CALLABLE.map(() => "?").join(",")})`, [r.name, ...CALLABLE]).filter(
      (d) => familyOf(langOf(d.path)!) === family,
    );
    if (!cands.length) return [];
    if (r.member) {
      if (r.recv) {
        const typed = cands.filter((d) => d.parent === r.recv || d.parent.endsWith(`.${r.recv}`));
        return typed.map((def) => ({ def, confidence: "exact" as const }));
      }
      const methods = cands.filter((d) => d.kind === "method");
      return methods.length === 1 ? [{ def: methods[0]!, confidence: "inferred" }] : [];
    }
    const plain = cands.filter((d) => d.kind !== "method");
    const local = plain.filter((d) => d.path === r.path);
    if (local.length) return local.map((def) => ({ def, confidence: "exact" as const }));
    const imported = plain.filter((d) => imports.get(r.path)?.has(d.path));
    if (imported.length) return imported.map((def) => ({ def, confidence: "exact" as const }));
    return plain.length === 1 ? [{ def: plain[0]!, confidence: "inferred" }] : [];
  }

  /** Each file's imports, resolved to files in the index where the language allows. */
  private imports(): Map<string, Set<string>> {
    if (this.importsOf) return this.importsOf;
    const files = new Set((this.db.query("SELECT path FROM files").all() as { path: string }[]).map((r) => r.path));
    const out = new Map<string, Set<string>>();
    for (const r of this.db.query("SELECT path, name FROM refs WHERE kind = 'import'").all() as { path: string; name: string }[]) {
      const target = resolveImport(r.path, r.name, files);
      if (!target) continue;
      let set = out.get(r.path);
      if (!set) out.set(r.path, (set = new Set()));
      set.add(target);
    }
    this.importsOf = out;
    return out;
  }

  /** Directories with their file and definition counts, and the most-used definitions. */
  map(under = ""): { dirs: { dir: string; files: number; defs: number }[]; hubs: { def: Def; uses: number }[] } {
    const prefix = under.replace(/^\.\/?/, "").replace(/\/?$/, under && under !== "." ? "/" : "");
    const rows = this.db
      .query("SELECT f.path AS path, (SELECT count(*) FROM defs d WHERE d.path = f.path) AS n FROM files f WHERE f.path LIKE ? ESCAPE '\\'")
      .all(`${prefix.replace(/[%_\\]/g, "\\$&")}%`) as { path: string; n: number }[];
    const dirs = new Map<string, { files: number; defs: number }>();
    for (const r of rows) {
      const rest = r.path.slice(prefix.length);
      const parts = rest.split("/");
      const dir = prefix + (parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0]! : ".");
      const e = dirs.get(dir) ?? { files: 0, defs: 0 };
      e.files++;
      e.defs += r.n;
      dirs.set(dir, e);
    }
    const hubs = (
      this.db
        .query(
          "SELECT d.id AS id, count(*) AS uses FROM refs r JOIN defs d ON d.name = r.name AND r.kind != 'import' WHERE d.path LIKE ? ESCAPE '\\' AND d.kind != 'method' GROUP BY d.id ORDER BY uses DESC LIMIT 12",
        )
        .all(`${prefix.replace(/[%_\\]/g, "\\$&")}%`) as { id: number; uses: number }[]
    ).map((h) => ({ def: this.def(h.id)!, uses: h.uses }));
    return { dirs: [...dirs].map(([dir, e]) => ({ dir, ...e })).sort((a, b) => b.defs - a.defs), hubs };
  }
}

function rowDef(r: Record<string, unknown>): Def {
  return {
    id: r.id as number,
    path: r.path as string,
    qname: r.qname as string,
    name: r.name as string,
    kind: r.kind as SymbolKind,
    parent: r.parent as string,
    line: r.line as number,
    endLine: r.end_line as number,
    signature: r.signature as string,
    exported: r.exported === 1,
    hash: r.hash as string,
  };
}

const JS_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];

/** The file an import names, when it is a file of this project (relative JS/TS, Python modules). */
export function resolveImport(from: string, spec: string, files: ReadonlySet<string>): string | undefined {
  const lang = langOf(from);
  const dir = path.posix.dirname(from);
  if (lang === "python") {
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    const mod = spec.slice(dots).replaceAll(".", "/");
    const bases = dots ? [path.posix.join(dir, ...Array(dots - 1).fill(".."), mod)] : [mod, path.posix.join(dir, mod)];
    for (const b of bases) for (const c of [`${b}.py`, `${b}/__init__.py`, `${b}.pyi`]) if (files.has(path.posix.normalize(c))) return path.posix.normalize(c);
    return undefined;
  }
  if (familyOf(lang ?? "go") !== "js" || !spec.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(dir, spec));
  const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
  for (const b of [base, stem]) for (const e of JS_EXTS) if (files.has(b + e)) return b + e;
  return undefined;
}
