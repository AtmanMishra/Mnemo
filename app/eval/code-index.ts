/**
 * Does the code index earn its place? No model, no network, no key: the TypeScript compiler is
 * the referee, and `grep -rnw` (what an agent without the index runs) is the baseline.
 *
 *   cd app && bun eval/code-index.ts                 # this project's own source
 *   bun eval/code-index.ts --sample 300              # more symbols
 *   bun eval/code-index.ts --json eval/results/code-index.json
 *
 * Three questions, each with a ground truth the compiler computes from the same files:
 *
 *   1. FIND   where is X defined? By its name, and by words from its doc comment (a task
 *             described in prose). Rank of the true definition; size of the answer.
 *   2. USERS  who calls X? The compiler's call sites (calls, `new`, extends/implements) against
 *             `code_refs` and against the lines `grep -w` returns. Precision, recall, size.
 *   3. IMPACT after an edit, what `codeImpact` appends (src/extensions/code.ts, `impactNote`),
 *             for three kinds of edit: a body-only change, a new required parameter, and a rename.
 *             Does the note fire, does it name callers that really exist, how big is it?
 *
 * Sizes are characters (4 is about a token). What the numbers cannot say is whether a model
 * given the answer does better; they say whether the answer is right and what it costs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { CodeIndex, words, type Def } from "../src/code/index.ts";
import { impactNote } from "../src/extensions/code.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const SAMPLE = Number(flag("--sample", "150"));
const APP = path.resolve(import.meta.dir, "..");

// ── the compiler's view ─────────────────────────────────────────────────────

interface Truth {
  rel: string;
  line: number;
  qname: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "enum";
  doc: string;
  /** `path:line` of each call, `new`, extends or implements. */
  sites: Set<string>;
  /** Every non-import mention, calls or not. */
  mentions: Set<string>;
}

function program() {
  const cfg = ts.readConfigFile(path.join(APP, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, APP);
  const files = new Map<string, { version: number }>();
  for (const f of parsed.fileNames) files.set(f, { version: 0 });
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (f) => String(files.get(f)?.version ?? 0),
    getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8")) : undefined),
    getCurrentDirectory: () => APP,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  return { ls, files: parsed.fileNames.filter((f) => f.startsWith(path.join(APP, "src") + path.sep)) };
}

const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function declarations(sf: ts.SourceFile): { node: ts.NamedDeclaration; name: ts.Identifier; qname: string; kind: Truth["kind"] }[] {
  const out: ReturnType<typeof declarations> = [];
  const visit = (node: ts.Node, owner?: string) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) out.push({ node, name: node.name, qname: node.name.text, kind: "function" });
    else if (ts.isClassDeclaration(node) && node.name) {
      out.push({ node, name: node.name, qname: node.name.text, kind: "class" });
      node.members.forEach((m) => visit(m, node.name!.text));
      return;
    } else if (ts.isMethodDeclaration(node) && owner && ts.isIdentifier(node.name) && node.body) out.push({ node, name: node.name, qname: `${owner}.${node.name.text}`, kind: "method" });
    else if (ts.isInterfaceDeclaration(node)) out.push({ node, name: node.name, qname: node.name.text, kind: "interface" });
    else if (ts.isTypeAliasDeclaration(node)) out.push({ node, name: node.name, qname: node.name.text, kind: "type" });
    else if (ts.isEnumDeclaration(node)) out.push({ node, name: node.name, qname: node.name.text, kind: "enum" });
    else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) out.push({ node: d, name: d.name, qname: d.name.text, kind: "function" });
    }
    if (!ts.isClassDeclaration(node) && !ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) ts.forEachChild(node, (c) => visit(c, owner));
  };
  sf.statements.forEach((s) => visit(s));
  return out;
}

function docOf(node: ts.Node, sf: ts.SourceFile): string {
  const target = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  const ranges = ts.getLeadingCommentRanges(sf.text, target.getFullStart()) ?? [];
  const last = ranges.filter((r) => sf.text.slice(r.pos, r.pos + 3) === "/**").at(-1);
  if (!last) return "";
  return sf.text
    .slice(last.pos, last.end)
    .replace(/^\/\*\*|\*\/$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .split(/\n\s*\n|\.\s/)[0]!
    .replace(/\s+/g, " ")
    .replace(/`/g, "")
    .trim();
}

function truthFor(ls: ts.LanguageService, files: string[]): Truth[] {
  const out: Truth[] = [];
  for (const file of files) {
    const sf = ls.getProgram()!.getSourceFile(file)!;
    const rel = path.relative(APP, file).split(path.sep).join("/");
    for (const d of declarations(sf)) {
      const refs = (ls.findReferences(file, d.name.getStart(sf)) ?? []).flatMap((r) => r.references).filter((r) => !r.isDefinition);
      const sites = new Set<string>();
      const mentions = new Set<string>();
      for (const r of refs) {
        const rsf = ls.getProgram()!.getSourceFile(r.fileName);
        if (!rsf) continue;
        const rrel = path.relative(APP, r.fileName).split(path.sep).join("/");
        if (rrel.startsWith("..") || rrel.includes("node_modules")) continue;
        const id = (function find(n: ts.Node): ts.Node | undefined {
          if (r.textSpan.start >= n.getStart(rsf) && r.textSpan.start < n.getEnd()) return ts.forEachChild(n, find) ?? n;
          return undefined;
        })(rsf);
        if (!id) continue;
        const parent = id.parent;
        if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) continue;
        const where = `${rrel}:${lineOf(rsf, id.getStart(rsf))}`;
        mentions.add(where);
        const callee = ts.isPropertyAccessExpression(parent) && parent.name === id ? parent : id;
        const up = callee.parent;
        const isCall = (ts.isCallExpression(up) || ts.isNewExpression(up)) && up.expression === callee;
        const isHeritage = ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent);
        const kindOk = d.kind === "function" || d.kind === "method" ? isCall : d.kind === "class" ? isCall || isHeritage : isHeritage;
        if (kindOk) sites.add(where);
      }
      out.push({ rel, line: lineOf(sf, d.name.getStart(sf)), qname: d.qname, kind: d.kind, doc: docOf(d.node, sf), sites, mentions });
    }
  }
  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(0)}%`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
/** Evenly spread, so the sample is the same on every run. */
function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]!);
}

function listAll(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(APP, d), { withFileTypes: true })) {
      const r = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!["node_modules", "dist", "eval", "python", ".git"].includes(e.name)) walk(r);
      } else if (/\.(tsx?|js|py)$/.test(e.name)) out.push(r);
    }
  };
  walk("");
  return out;
}

const textFiles = listAll();
const fileText = new Map(textFiles.map((f) => [f, fs.readFileSync(path.join(APP, f), "utf8").split("\n")]));

/** What `grep -rnw <word>` prints for this project: path:line:text for each hit. */
function grepWord(word: string, ignoreCase = false): { hits: string[]; chars: number } {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, ignoreCase ? "i" : "");
  const hits: string[] = [];
  let chars = 0;
  for (const [f, lines] of fileText)
    lines.forEach((l, i) => {
      if (re.test(l)) {
        hits.push(`${f}:${i + 1}`);
        chars += f.length + String(i + 1).length + l.length + 3;
      }
    });
  return { hits, chars };
}

// ── run ─────────────────────────────────────────────────────────────────────

const t0 = performance.now();
const { ls, files } = program();
const truth = truthFor(ls, files);
const tTruth = performance.now() - t0;

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-codeeval-"));
const ix = new CodeIndex(path.join(dbDir, "code.db"), APP, { list: () => textFiles });
const tb = performance.now();
const built = await ix.refresh();
const tBuild = performance.now() - tb;
const tr = performance.now();
await ix.refresh();
const tRefresh = performance.now() - tr;
const dbBytes = fs.statSync(path.join(dbDir, "code.db")).size;

const defAt = (t: Truth): Def | undefined => ix.fileDefs(t.rel).find((d) => d.line === t.line || (d.qname === t.qname && Math.abs(d.line - t.line) <= 1));
const covered = truth.filter((t) => defAt(t));

console.log(`# Code index eval — ${path.basename(APP)}/src, ${new Date().toISOString().slice(0, 10)}\n`);
console.log(`corpus: ${textFiles.length} files indexed (${built.files} parsed), ${truth.length} declarations by the compiler, ${covered.length} found by the index (${pct(covered.length, truth.length)})`);
console.log(`index: cold build ${tBuild.toFixed(0)} ms, no-change refresh ${tRefresh.toFixed(0)} ms, ${(dbBytes / 1024).toFixed(0)} KB on disk (compiler setup ${tTruth.toFixed(0)} ms for comparison)\n`);
const missing = truth.filter((t) => !defAt(t));
if (missing.length) console.log(`missed by the index: ${missing.slice(0, 8).map((t) => `${t.qname} (${t.rel}:${t.line})`).join(", ")}${missing.length > 8 ? ", …" : ""}\n`);

const results: Record<string, unknown> = { corpus: { files: textFiles.length, declarations: truth.length, covered: covered.length }, index: { buildMs: tBuild, refreshMs: tRefresh, dbKB: dbBytes / 1024 } };

// 1. FIND ---------------------------------------------------------------------

{
  const probes = spread(covered.filter((t) => t.qname.length > 3), SAMPLE);
  const byName = { r1: 0, r3: 0, r10: 0, chars: [] as number[], grepChars: [] as number[], grepLines: [] as number[], grepHit: 0 };
  for (const t of probes) {
    const hits = ix.search(t.qname.split(".").pop()!, 10);
    const rank = hits.findIndex((d) => d.path === t.rel && d.line === defAt(t)!.line);
    if (rank === 0) byName.r1++;
    if (rank >= 0 && rank < 3) byName.r3++;
    if (rank >= 0) byName.r10++;
    byName.chars.push(hits.map((d) => `${d.kind} ${d.qname}  ${d.path}:${d.line}\n    ${d.signature}`).join("\n").length);
    const g = grepWord(t.qname.split(".").pop()!);
    byName.grepChars.push(g.chars);
    byName.grepLines.push(g.hits.length);
    if (g.hits.includes(`${t.rel}:${t.line}`)) byName.grepHit++;
  }
  console.log(`## 1a. Find a definition by its name (${probes.length} symbols)\n`);
  console.log("| | found at rank 1 | in top 3 | in top 10 | answer size (median chars) |\n|---|---|---|---|---|");
  console.log(`| code_search | ${pct(byName.r1, probes.length)} | ${pct(byName.r3, probes.length)} | ${pct(byName.r10, probes.length)} | ${median(byName.chars)} |`);
  console.log(`| grep -rnw name | the line is in the output ${pct(byName.grepHit, probes.length)} | | | ${median(byName.grepChars)} (median ${median(byName.grepLines)} lines, mean ${mean(byName.grepLines).toFixed(0)}) |\n`);
  results.findByName = { n: probes.length, rank1: byName.r1 / probes.length, top3: byName.r3 / probes.length, top10: byName.r10 / probes.length, medianChars: median(byName.chars), grepMedianChars: median(byName.grepChars) };

  const prose = spread(covered.filter((t) => t.doc.split(" ").length >= 5), SAMPLE);
  const p = { r1: 0, r3: 0, r10: 0, grepHit: 0, grepLines: [] as number[] };
  for (const t of prose) {
    // The first six words of the doc comment that are not stop words: what a person would type to describe it.
    const q = t.doc
      .split(/\s+/)
      .map((w) => w.replace(/[^A-Za-z0-9_]/g, ""))
      .filter((w) => w.length > 3 && !/^(the|that|this|with|from|into|when|them|their|what|which|have|each|then|than|only|also|does|will)$/i.test(w))
      .slice(0, 6)
      .join(" ");
    if (!q) continue;
    const hits = ix.search(q, 10);
    const rank = hits.findIndex((d) => d.path === t.rel && d.line === defAt(t)!.line);
    if (rank === 0) p.r1++;
    if (rank >= 0 && rank < 3) p.r3++;
    if (rank >= 0) p.r10++;
    // An agent greps the longest word of the description, case-insensitively.
    const longest = [...q.split(" ")].sort((a, b) => b.length - a.length)[0]!;
    const g = grepWord(longest, true);
    p.grepLines.push(g.hits.length);
    if (g.hits.length <= 40 && g.hits.some((h) => h.startsWith(`${t.rel}:`) && Math.abs(Number(h.split(":")[1]) - t.line) <= 3)) p.grepHit++;
  }
  console.log(`## 1b. Find a definition from words about it (${prose.length} symbols with a doc comment; query = its first words)\n`);
  console.log("| | found at rank 1 | in top 3 | in top 10 |\n|---|---|---|---|");
  console.log(`| code_search | ${pct(p.r1, prose.length)} | ${pct(p.r3, prose.length)} | ${pct(p.r10, prose.length)} |`);
  console.log(`| grep -i <longest word> | definition within the first 40 lines of output: ${pct(p.grepHit, prose.length)} (median ${median(p.grepLines)} lines of output) | | |\n`);
  results.findByWords = { n: prose.length, rank1: p.r1 / prose.length, top3: p.r3 / prose.length, top10: p.r10 / prose.length, grepHit: p.grepHit / prose.length };
}

// 2. USERS --------------------------------------------------------------------

const withUsers = covered.filter((t) => t.sites.size > 0);
{
  const probes = spread(withUsers, SAMPLE);
  const sure = { tp: 0, fp: 0, fn: 0, fileTp: 0, fileFp: 0, fileFn: 0 };
  const site = { tp: 0, fp: 0, fn: 0, exactTp: 0, exactFp: 0, inferredTp: 0, inferredFp: 0, chars: [] as number[], perfect: 0 };
  const file = { tp: 0, fp: 0, fn: 0 };
  const g = { tp: 0, fp: 0, fn: 0, chars: [] as number[], fileFp: 0, fileTp: 0 };
  let untied = 0;
  for (const t of probes) {
    const d = defAt(t)!;
    const r = ix.callers(d);
    untied += r.untied;
    const pred = new Map(r.edges.map((e) => [`${e.path}:${e.line}`, e.confidence]));
    let tp = 0;
    for (const [k, conf] of pred) {
      if (t.sites.has(k)) {
        site.tp++;
        tp++;
        conf === "exact" ? site.exactTp++ : site.inferredTp++;
      } else {
        site.fp++;
        conf === "exact" ? site.exactFp++ : site.inferredFp++;
      }
    }
    site.fn += [...t.sites].filter((k) => !pred.has(k)).length;
    if (tp === t.sites.size && pred.size === t.sites.size) site.perfect++;
    const predFiles = new Set([...pred.keys()].map((k) => k.split(":")[0]!));
    const trueFiles = new Set([...t.sites].map((k) => k.split(":")[0]!));
    const exactKeys = new Set([...pred].filter(([, c]) => c === "exact").map(([k]) => k));
    for (const k of exactKeys) t.sites.has(k) ? sure.tp++ : sure.fp++;
    sure.fn += [...t.sites].filter((k) => !exactKeys.has(k)).length;
    const exactFiles = new Set([...exactKeys].map((k) => k.split(":")[0]!));
    for (const f of exactFiles) trueFiles.has(f) ? sure.fileTp++ : sure.fileFp++;
    sure.fileFn += [...trueFiles].filter((f) => !exactFiles.has(f)).length;
    for (const f of predFiles) trueFiles.has(f) ? file.tp++ : file.fp++;
    file.fn += [...trueFiles].filter((f) => !predFiles.has(f)).length;
    site.chars.push(r.edges.map((e) => `${e.from?.qname ?? "(top level)"}  ${e.path}:${e.line}`).join("\n").length + 40);

    const gw = grepWord(t.qname.split(".").pop()!);
    const own = `${t.rel}:${t.line}`;
    const gs = new Set(gw.hits.filter((h) => h !== own));
    for (const k of gs) t.sites.has(k) ? g.tp++ : g.fp++;
    g.fn += [...t.sites].filter((k) => !gs.has(k)).length;
    g.chars.push(gw.chars);
    const gFiles = new Set([...gs].map((k) => k.split(":")[0]!));
    for (const f of gFiles) trueFiles.has(f) ? g.fileTp++ : g.fileFp++;
  }
  const P = (tp: number, fp: number) => pct(tp, tp + fp);
  const R = (tp: number, fn: number) => pct(tp, tp + fn);
  console.log(`## 2. Who uses X (${probes.length} symbols that have at least one call, \`new\`, extends or implements)\n`);
  console.log("| | call-site precision | call-site recall | file precision | file recall | answer size (median chars) |\n|---|---|---|---|---|---|");
  console.log(`| code_refs, confirmed links only (what it lists as users) | ${P(sure.tp, sure.fp)} | ${R(sure.tp, sure.fn)} | ${P(sure.fileTp, sure.fileFp)} | ${R(sure.fileTp, sure.fileFn)} | ${median(site.chars)} |`);
  console.log(`| code_refs, with its "possible" list | ${P(site.tp, site.fp)} | ${R(site.tp, site.fn)} | ${P(file.tp, file.fp)} | ${R(file.tp, file.fn)} | |`);
  console.log(`| grep -rnw name | ${P(g.tp, g.fp)} | ${R(g.tp, g.fn)} | ${P(g.fileTp, g.fileFp)} | | ${median(g.chars)} |`);
  console.log(`\ncode_refs gets every site and no extra for ${pct(site.perfect, probes.length)} of the symbols. Links marked exact: precision ${P(site.exactTp, site.exactFp)} (${site.exactTp + site.exactFp} links); marked inferred: ${P(site.inferredTp, site.inferredFp)} (${site.inferredTp + site.inferredFp} links). ${untied} calls were counted as "could not tie" instead of guessed.\n`);
  results.users = { n: probes.length, confirmedPrecision: sure.tp / Math.max(1, sure.tp + sure.fp), confirmedRecall: sure.tp / Math.max(1, sure.tp + sure.fn), allPrecision: site.tp / Math.max(1, site.tp + site.fp), allRecall: site.tp / Math.max(1, site.tp + site.fn), grepSitePrecision: g.tp / Math.max(1, g.tp + g.fp), grepSiteRecall: g.tp / Math.max(1, g.tp + g.fn), medianChars: median(site.chars), grepMedianChars: median(g.chars) };
}

// 3. IMPACT -------------------------------------------------------------------

{
  // The edits are made in a copy, so the corpus stays as it is.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-codeeval-copy-"));
  for (const f of textFiles) {
    fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
    fs.copyFileSync(path.join(APP, f), path.join(copy, f));
  }
  const external = (t: Truth) => [...t.sites].filter((s) => !s.startsWith(`${t.rel}:`));
  const candidates = covered.filter((t) => (t.kind === "function" || t.kind === "method") && external(t).length > 0 && !t.rel.includes("test"));
  const probes = spread(candidates, Math.min(SAMPLE, 80));
  type Row = { fired: number; edits: number; chars: number[]; tp: number; lines: number; recallNum: number; recallDen: number; breaking: number };
  const row = (): Row => ({ fired: 0, edits: 0, chars: [], tp: 0, lines: 0, recallNum: 0, recallDen: 0, breaking: 0 });
  const stats = { body: row(), param: row(), rename: row() };
  const sf = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");

  for (const kind of ["body", "param", "rename"] as const) {
    for (const t of probes) {
      const copyIx = new CodeIndex(path.join(dbDir, `impact-${kind}.db`), copy, { list: () => textFiles });
      // One index per edit kind, rebuilt from the original text before each edit and left alone after.
      const original = sf(t.rel);
      fs.writeFileSync(path.join(copy, t.rel), original);
      await copyIx.refresh();
      const d = copyIx.fileDefs(t.rel).find((x) => x.qname === t.qname && Math.abs(x.line - t.line) <= 1);
      if (!d) {
        copyIx.close();
        continue;
      }
      const lines = original.split("\n");
      const open = lines[d.line - 1]!;
      let edited: string | undefined;
      if (kind === "body") {
        // A change inside the body: the callers' view of it is unchanged.
        const bodyLine = lines.findIndex((l, i) => i >= d.line - 1 && l.includes("{"));
        if (bodyLine >= 0) {
          lines.splice(bodyLine + 1, 0, "  /* eval: touched */");
          edited = lines.join("\n");
        }
      } else if (kind === "param") {
        const m = /\(/.exec(open);
        if (m) {
          lines[d.line - 1] = open.replace(/\(\s*\)/, "(extra: string)").replace(/\(([^)])/, "(extra: string, $1");
          edited = lines.join("\n");
        }
      } else {
        lines[d.line - 1] = open.replace(new RegExp(`\\b${d.name}\\b`), `${d.name}Renamed`);
        edited = lines.join("\n");
      }
      if (!edited || edited === original) {
        copyIx.close();
        continue;
      }
      fs.writeFileSync(path.join(copy, t.rel), edited);
      const note = await impactNote(copyIx, t.rel);
      const s = stats[kind];
      s.edits++;
      if (note) {
        s.fired++;
        s.chars.push(note.length);
        const listed = note.split("\n").filter((l) => l.startsWith("  "));
        const truthExt = new Set(external(t).map((x) => x.split(":")[0]!));
        s.lines += listed.length;
        // A listed line is right when it names a file that really calls this symbol.
        for (const l of listed) {
          const m = /\s(\S+):(\d+)/.exec(l);
          if (m && truthExt.has(m[1]!)) s.tp++;
        }
        const named = new Set(listed.map((l) => /\s(\S+):\d+/.exec(l)?.[1]).filter(Boolean));
        s.recallNum += [...truthExt].filter((f) => named.has(f)).length;
      }
      s.recallDen += new Set(external(t).map((x) => x.split(":")[0]!)).size;
      if (kind !== "body") s.breaking++;
      copyIx.close();
      fs.writeFileSync(path.join(copy, t.rel), original);
    }
  }
  console.log(`## 3. codeImpact: the note after an edit (${probes.length} functions or methods with callers elsewhere; edit made in a copy)\n`);
  console.log("| edit | note appears | what is in a note: lines that name a real caller file | caller files named / caller files that exist | median added chars |\n|---|---|---|---|---|");
  const label = { body: "a change inside the body (callers cannot break)", param: "a new required first parameter (callers break)", rename: "the function renamed (callers break)" } as const;
  for (const k of ["body", "param", "rename"] as const) {
    const s = stats[k];
    console.log(`| ${label[k]} | ${pct(s.fired, s.edits)} of ${s.edits} | ${pct(s.tp, s.lines)} of ${s.lines} | ${pct(s.recallNum, s.recallDen)} | ${median(s.chars)} |`);
  }
  console.log("");
  results.impact = Object.fromEntries((["body", "param", "rename"] as const).map((k) => [k, { edits: stats[k].edits, appears: stats[k].fired / Math.max(1, stats[k].edits), linePrecision: stats[k].tp / Math.max(1, stats[k].lines), callerFileRecall: stats[k].recallNum / Math.max(1, stats[k].recallDen), medianChars: median(stats[k].chars) }]));
  fs.rmSync(copy, { recursive: true, force: true });
}

ix.close();
fs.rmSync(dbDir, { recursive: true, force: true });
const out = flag("--json");
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
}
void words;
