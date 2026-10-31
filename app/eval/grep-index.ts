/**
 * Does the text index make grep faster, and does it ever answer differently from ripgrep?
 * No model, no network, no key.
 *
 *   cd app && bun eval/grep-index.ts              # this repository
 *   bun eval/grep-index.ts /path/to/a/large/repo   # any git checkout
 *
 * For each pattern: how many files the index lets grep read, the time of a call as the agent
 * makes one (100 matches at most) with the index and reading every file (what grep is without
 * the index or ripgrep), and `rg` over the same files (all matches; ripgrep searches in parallel).
 * Then the lines themselves, all of them, against rg's. The freshness check every call makes
 * first (git's file list and a stat of each file) is timed apart; the build time is the one-off
 * cost of the first grep in a project.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeIndex } from "../src/code/index.ts";
import { compile, grepLines } from "../src/code/text.ts";
import { indexedGrep } from "../src/extensions/code.ts";

const root = fs.realpathSync(path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../..")));
const PATTERNS = [
  "parseConfig",
  "TODO|FIXME",
  "function\\s+\\w+Error",
  "export (async )?function",
  "import .* from",
  "new Map\\(",
  "settings\\.get\\(\\)",
  "zzqxv_never_there",
];

const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-grep-eval-")), "code.db");
const ix = new CodeIndex(db, root);
let t = performance.now();
const built = await ix.refreshText();
const buildMs = performance.now() - t;
const size = fs.statSync(db).size + (fs.existsSync(`${db}-wal`) ? fs.statSync(`${db}-wal`).size : 0);
console.log(`${root}: ${built.files} files, ${ix.textFiles().length} text; built in ${(buildMs / 1000).toFixed(1)} s, index ${(size / 1e6).toFixed(1)} MB${ix.trigrams ? "" : " (no trigram support: every file is read)"}\n`);

const rg = Bun.which("rg");
const files = ix.textFiles();
const ms = async (f: () => unknown, n = 5) => {
  await f();
  const s = performance.now();
  for (let i = 0; i < n; i++) await f();
  return (performance.now() - s) / n;
};
const fresh = await ms(() => ix.refreshText());
console.log(`freshness check (every call makes it, before searching): ${fresh.toFixed(0)} ms\n`);
console.log("pattern".padEnd(26), "candidates".padStart(11), "indexed".padStart(8), "all files".padStart(10), "rg".padStart(7), "  same lines as rg");
let differ = 0;
for (const pattern of PATTERNS) {
  const re = compile(pattern)!;
  // A call as the agent makes one (100 matches at most), with the index and reading every file.
  const indexed = await ms(() => indexedGrep(ix, re, { pattern }, root));
  const scan = await ms(() => grepLines((function* () { for (const f of files) yield { shown: f, text: fs.readFileSync(path.join(root, f), "utf8") }; })(), re, { limit: 100 }));
  const r = indexedGrep(ix, re, { pattern, limit: 1_000_000 }, root)!;
  const got = (r.content[0] as { text: string }).text.replace(/\n\n\[[^\n]*\]$/, "");
  // Over 50 KB the output is cut, as pi's grep cuts it: then each line shown must be one of rg's.
  const cut = !!(r.details as { truncation?: unknown }).truncation;
  const lines = got === "No matches found" ? [] : got.split("\n");
  let rgMs = NaN;
  let same = "rg not installed";
  if (rg) {
    const run = () => spawnSync(rg, ["--line-number", "--no-heading", "--with-filename", "--color=never", "--", pattern, ...files], { cwd: root, encoding: "utf8", maxBuffer: 1 << 30 });
    rgMs = await ms(run);
    const want = run()
      .stdout.split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^([^:]+):(\d+):/, "$1:$2: "));
    const a = new Set(lines.map((l) => l.slice(0, 520)));
    const b = new Set(want.map((l) => l.slice(0, 520)));
    const missing = cut ? 0 : [...b].filter((l) => !a.has(l)).length;
    const extra = [...a].filter((l) => !b.has(l)).length;
    same = missing || extra ? `NO: ${missing} missing, ${extra} extra` : `yes (${cut ? `first ${lines.length} of ${want.length}, cut at 50 KB` : `${lines.length}`})`;
    if (missing || extra) differ++;
  }
  const d = (indexedGrep(ix, re, { pattern }, root)!.details as { index: { read: number; of: number } }).index;
  const f = (n: number) => `${n.toFixed(0)} ms`.padStart(8);
  console.log(pattern.padEnd(26), `${d.read}/${d.of}`.padStart(11), f(indexed), f(scan).padStart(10), f(rgMs).padStart(7), " ", same);
}
ix.close();
fs.rmSync(path.dirname(db), { recursive: true, force: true });
if (differ) process.exitCode = 1;
