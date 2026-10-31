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
 * Beside the definitions it keeps a text index for grep: every text file of the project (not
 * only source), as the set of three-character sequences it holds. It is built and refreshed
 * only when grep asks (`refreshText`), never by the code tools.
 *
 * What it never holds: file bodies (snippets are read from disk when asked for; the text index
 * is contentless), files a read tool may not read (the caller's `exclude`), files over 1 MiB,
 * and binary files.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { redact } from "@mnemo/memory";
import { listFiles } from "../ui/files.ts";
import { extract, type Definition, type SymbolKind } from "./extract.ts";
import { familyOf, langOf, parsers, type LangId } from "./languages.ts";

/** Bump when the tables or what the extractor writes into them change: the index is rebuilt. */
const SCHEMA = "2";
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
  /** Whether this SQLite has the trigram index; without it grep narrows nothing. */
  readonly trigrams: boolean;
  /** Files each file imports, rebuilt after a refresh changes anything. */
  private importsOf?: Map<string, Set<string>>;
  /**
   * Each definition's rank in the call graph, and how many files changed since it was made. A
   * rank only nudges search, so it is made again once 2% of the files (at least 20) changed,
   * not after every edit: on 15,000 files it takes about 4 s.
   */
  private rankOf?: { ranks: Map<number, number>; changed: number };

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
      for (const t of ["files", "defs", "refs", "defs_fts", "text_files", "text_fts"]) this.db.run(`DROP TABLE IF EXISTS ${t}`);
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
    // Every text file for grep: which trigrams it holds, never its text (contentless).
    this.db.run("CREATE TABLE IF NOT EXISTS text_files (id INTEGER PRIMARY KEY, path TEXT UNIQUE, size INTEGER, mtime REAL, hash TEXT, text INTEGER)");
    try {
      this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS text_fts USING fts5(body, tokenize='trigram', content='', contentless_delete=1, detail='none')");
      this.trigrams = true;
    } catch {
      // An SQLite older than 3.43 (an old macOS's own): grep reads every text file instead.
      this.trigrams = false;
    }
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
    if (read || removed) this.changed(read + removed);
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
      this.changed(1);
      return;
    }
    if (!st.isFile() || st.size > MAX_BYTES) return;
    if (this.readFile(rel, st, await parsers())) this.changed(1);
  }

  private changed(files: number): void {
    this.importsOf = undefined;
    if (this.rankOf && (this.rankOf.changed += files) > Math.max(20, this.files() / 50)) this.rankOf = undefined;
  }

  /** Bring the text index (every text file, for grep) up to date with the files on disk. */
  async refreshText(): Promise<RefreshResult> {
    const known = new Map(
      (this.db.query("SELECT path, size, mtime, hash FROM text_files").all() as { path: string; size: number; mtime: number; hash: string }[]).map((r) => [r.path, r]),
    );
    const wanted = this.list(this.root).filter((f) => !this.exclude(f));
    const sources = wanted.filter((f) => langOf(f)).length;
    if (sources > this.maxFiles) return { read: 0, removed: 0, files: 0, tooMany: sources };
    const seen = new Set<string>();
    let read = 0;
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
      if (this.readText(rel, st, k?.hash) && ++read % 50 === 0) await new Promise((r) => setTimeout(r, 0)); // let the interface draw
    }
    let removed = 0;
    for (const rel of known.keys())
      if (!seen.has(rel)) {
        this.forgetText(rel);
        removed++;
      }
    return { read, removed, files: seen.size };
  }

  private readText(rel: string, st: fs.Stats, oldHash?: string): boolean {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(this.root, rel));
    } catch {
      return false;
    }
    const hash = Bun.hash(bytes).toString(36);
    if (hash === oldHash) {
      this.db.run("UPDATE text_files SET size = ?, mtime = ? WHERE path = ?", [st.size, st.mtimeMs, rel]);
      return false;
    }
    const text = !bytes.subarray(0, 8192).includes(0);
    this.db.transaction(() => {
      this.forgetText(rel);
      const r = this.db.run("INSERT INTO text_files (path, size, mtime, hash, text) VALUES (?, ?, ?, ?, ?)", [rel, st.size, st.mtimeMs, hash, text ? 1 : 0]);
      if (text && this.trigrams) this.db.run("INSERT INTO text_fts (rowid, body) VALUES (?, ?)", [r.lastInsertRowid, bytes.toString("utf8")]);
    })();
    return true;
  }

  private forgetText(rel: string): void {
    if (this.trigrams) this.db.run("DELETE FROM text_fts WHERE rowid IN (SELECT id FROM text_files WHERE path = ?)", [rel]);
    this.db.run("DELETE FROM text_files WHERE path = ?", [rel]);
  }

  /**
   * Text files, in path order: all of them, or only those holding every trigram of one of the
   * alternatives (see code/text.ts `requiredGrams`).
   */
  textFiles(grams?: string[][]): string[] {
    if (!grams || !this.trigrams) return (this.db.query("SELECT path FROM text_files WHERE text = 1 ORDER BY path").all() as { path: string }[]).map((r) => r.path);
    const match = grams.map((b) => `(${b.map((g) => `"${g.replaceAll('"', '""')}"`).join(" AND ")})`).join(" OR ");
    return (
      this.db.query("SELECT f.path AS path FROM text_fts JOIN text_files f ON f.id = text_fts.rowid WHERE text_fts MATCH ? AND f.text = 1 ORDER BY f.path").all(match) as { path: string }[]
    ).map((r) => r.path);
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

  /** Definitions ranked for plain words or identifiers: BM25, nudged towards what the call graph says is central. */
  search(query: string, k = 10): Def[] {
    const terms = [...new Set(words(query).split(" ").filter(Boolean))];
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(" OR ");
    const rows = this.db
      .query("SELECT d.*, bm25(defs_fts, 10.0, 2.0, 1.0) AS rank FROM defs_fts JOIN defs d ON d.id = defs_fts.rowid WHERE defs_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(match, k * 5) as (Record<string, unknown> & { rank: number })[];
    const rank = this.ranks();
    const ranked = rows.map((r) => {
        const d = rowDef(r);
        // bm25 is negative, lower is better; a definition much of the project reaches, and an
        // exported one, is the likelier answer (rank 1 is the average definition: log 0).
        // Asking for a name by its name finds that definition first.
        const named = d.name.toLowerCase() === query.trim().toLowerCase() || d.qname.toLowerCase() === query.trim().toLowerCase();
        return { d, score: -r.rank + 0.4 * Math.log(rank.get(d.id) ?? 1) + (d.exported ? 0.3 : 0) + (named ? 100 : 0) };
      });
    return ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => s.d);
  }

  /**
   * PageRank over the calls the index can tie (exact or inferred), scaled so the average
   * definition is 1: what much of the project reaches, directly or through what calls it, ranks
   * above what one test calls. Built from memory (no query per call), and kept while few files
   * have changed (`rankOf`); a definition newer than the ranks is average.
   */
  ranks(): Map<number, number> {
    if (this.rankOf) return this.rankOf.ranks;
    const imports = this.imports();
    const all = this.defs("");
    const owner = new Map(all.map((d) => [`${d.path}#${d.qname}`, d.id]));
    const byName = new Map<string, Def[]>();
    for (const d of all)
      if (CALLABLE.includes(d.kind)) {
        const k = `${familyOf(langOf(d.path)!)} ${d.name}`;
        const list = byName.get(k);
        if (list) list.push(d);
        else byName.set(k, [d]);
      }
    const named = new Map([...byName].map(([k, defs]) => [k, group(defs)]));
    // Calls as edges between positions in `all`, then thirty rounds of PageRank over arrays.
    const at = new Map(all.map((d, i) => [d.id, i]));
    const from: number[] = [];
    const to: number[] = [];
    for (const r of this.db.query("SELECT * FROM refs WHERE kind = 'call' AND src != ''").all() as RefRow[]) {
      const src = owner.get(`${r.path}#${r.src}`);
      const cands = named.get(`${familyOf(langOf(r.path)!)} ${r.name}`);
      if (src === undefined || !cands) continue;
      for (const t of this.tie(r, imports, cands))
        if (t.def.id !== src) {
          from.push(at.get(src)!);
          to.push(at.get(t.def.id)!);
        }
    }
    const n = all.length || 1;
    const outDegree = new Float64Array(n);
    for (const f of from) outDegree[f]!++;
    const damping = 0.85;
    let pr = new Float64Array(n).fill(1 / n);
    for (let round = 0; round < 30; round++) {
      let dangling = 0;
      for (let i = 0; i < n; i++) if (!outDegree[i]) dangling += pr[i]!;
      const next = new Float64Array(n).fill((1 - damping + damping * dangling) / n);
      for (let e = 0; e < from.length; e++) next[to[e]!]! += (damping * pr[from[e]!]!) / outDegree[from[e]!]!;
      pr = next;
    }
    const ranks = new Map(all.map((d, i) => [d.id, pr[i]! * n]));
    this.rankOf = { ranks, changed: 0 };
    return ranks;
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
  private tie(r: RefRow, imports: Map<string, Set<string>>, named?: Named): { def: Def; confidence: Confidence }[] {
    const g =
      named ??
      group(
        this.defs(`WHERE name = ? AND kind IN (${CALLABLE.map(() => "?").join(",")})`, [r.name, ...CALLABLE]).filter(
          (d) => familyOf(langOf(d.path)!) === familyOf(langOf(r.path)!),
        ),
      );
    if (r.member) {
      if (r.recv) {
        const typed = (g.byParent.get(lastPart(r.recv)) ?? []).filter((d) => d.parent === r.recv || d.parent.endsWith(`.${r.recv}`));
        return typed.map((def) => ({ def, confidence: "exact" as const }));
      }
      return g.methods.length === 1 ? [{ def: g.methods[0]!, confidence: "inferred" }] : [];
    }
    const local = g.byPath.get(r.path);
    if (local) return local.map((def) => ({ def, confidence: "exact" as const }));
    const from = imports.get(r.path);
    const imported = from ? g.plain.filter((d) => from.has(d.path)) : [];
    if (imported.length) return imported.map((def) => ({ def, confidence: "exact" as const }));
    return g.plain.length === 1 ? [{ def: g.plain[0]!, confidence: "inferred" }] : [];
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

/** The definitions of one name in one language family, as `tie` reads them. */
interface Named {
  methods: Def[];
  /** Everything with a parent, by the parent's last part (`Cache` for `a.Cache`). */
  byParent: Map<string, Def[]>;
  /** What is not a method. */
  plain: Def[];
  /** What is not a method, by file. */
  byPath: Map<string, Def[]>;
}

const lastPart = (name: string) => name.slice(name.lastIndexOf(".") + 1);

function group(defs: Def[]): Named {
  const g: Named = { methods: [], byParent: new Map(), plain: [], byPath: new Map() };
  const add = (m: Map<string, Def[]>, k: string, d: Def) => {
    const list = m.get(k);
    if (list) list.push(d);
    else m.set(k, [d]);
  };
  for (const d of defs) {
    if (d.parent) add(g.byParent, lastPart(d.parent), d);
    if (d.kind === "method") g.methods.push(d);
    else {
      g.plain.push(d);
      add(g.byPath, d.path, d);
    }
  }
  return g;
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
