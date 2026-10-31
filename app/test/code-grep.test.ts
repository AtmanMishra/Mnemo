/**
 * grep behind the code index's text index: what a pattern says every match must contain, that
 * narrowing never loses a match (against a full scan, and against ripgrep where it is
 * installed), that the index stays fresh and never holds what a read may not see, and the
 * tool on a real session.
 */
import { test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { CodeIndex } from "../src/code/index.ts";
import { compile, globMatch, grepLines, requiredGrams } from "../src/code/text.ts";
import { indexedGrep } from "../src/extensions/code.ts";
import { mnemoEnv } from "./helpers.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

function project(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-grep-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  // The long name on Windows (C:\Users\RUNNER~1 is not the folder the index names), as Mnemo resolves a project.
  return fs.realpathSync.native(dir);
}

function walk(root: string, dir = root): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(root, full) : [path.relative(root, full).split(path.sep).join("/")];
  });
}

function indexOf(root: string, exclude?: (rel: string) => boolean): CodeIndex {
  const ix = new CodeIndex(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ix-")), "code.db"), root, { list: walk, exclude });
  cleanup.push(() => ix.close());
  return ix;
}

const out = (r: ReturnType<typeof indexedGrep>) => (r?.content[0] as { text: string } | undefined)?.text ?? "";

const files = {
  "src/config.ts": "export function parseConfig(raw: string) {\n  return JSON.parse(raw);\n}\nconst colour = 'red'; // British\n",
  "src/fetch.ts": "import { parseConfig } from './config';\nexport async function fetchJson(url: string) {\n  const r = await fetch(url);\n  return parseConfig(await r.text());\n}\n",
  "src/util.py": "def retry_backoff(n):\n    return 2 ** n  # color\n",
  "README.md": "# Demo\nRun `bun test`. The color is blue.\nTODO: write docs\n",
  "notes/todo.txt": "TODO: ship it\ntodo lower\n",
  "assets/logo.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x54, 0x4f, 0x44, 0x4f]),
};

// ── the planner ──────────────────────────────────────────────────────────────

test("a pattern names the trigrams every match contains, and gives up only what it cannot be sure of", () => {
  expect(requiredGrams("parseConfig", true)).toEqual([["par", "ars", "rse", "sec", "eco", "con", "onf", "nfi", "fig"]]);
  expect(requiredGrams("fetch.*Json")).toEqual([["fet", "etc", "tch", "jso", "son"]]);
  // An optional character, a zero-minimum repeat, a group and a class are left out.
  expect(requiredGrams("colou?r")).toEqual([["col", "olo"]]);
  expect(requiredGrams("ab{0,2}cdef")).toEqual([["cde", "def"]]);
  expect(requiredGrams("(get|set)Value")).toEqual([["val", "alu", "lue"]]);
  expect(requiredGrams("[A-Z]+Error")).toEqual([["err", "rro", "ror"]]);
  // Escapes: punctuation is itself, a letter is a class or an anchor.
  expect(requiredGrams("\\bfoo\\(")).toEqual([["foo", "oo("]]);
  expect(requiredGrams("a\\.b\\.c")).toEqual([["a.b", ".b.", "b.c"]]);
  // Alternatives at the top: each must name some trigram, or nothing narrows.
  expect(requiredGrams("TODO|FIXME")).toEqual([["tod", "odo"], ["fix", "ixm", "xme"]]);
  expect(requiredGrams("TODO|x")).toBeUndefined();
  expect(requiredGrams("a.b")).toBeUndefined();
  expect(requiredGrams("\\w+")).toBeUndefined();
});

test("a pattern JavaScript reads differently from ripgrep is not matched here", () => {
  expect(compile("[[:alpha:]]+")).toBeUndefined();
  expect(compile("(?P<n>a)")).toBeUndefined();
  expect(compile("\\p{L}")).toBeUndefined();
  expect(compile("\\Afoo\\z")).toBeUndefined();
  expect(compile("(unclosed")).toBeUndefined();
  expect(compile("(?i)todo")!.test("TODO")).toBe(true);
  expect(compile("todo", { ignoreCase: true })!.test("ToDo")).toBe(true);
  expect(compile("a.b", { literal: true })!.test("axb")).toBe(false);
  expect(compile("(?:get|set)\\w+")!.test("setValue")).toBe(true);
});

test("globs match like ripgrep's: a name at any depth without a slash, a path with one, ! excludes", () => {
  expect(globMatch("*.ts", "src/deep/a.ts")).toBe(true);
  expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
  expect(globMatch("src/*.ts", "lib/a.ts")).toBe(false);
  expect(globMatch("**/*.spec.ts", "a.spec.ts")).toBe(true);
  expect(globMatch("!*.md", "README.md")).toBe(false);
  expect(globMatch("!*.md", "a.ts")).toBe(true);
});

test("lines come out in pi's grep format, with context and the limit", () => {
  const r = grepLines([{ shown: "a.txt", text: "one\ntwo\nthree\ntwo again\n" }], /two/, { context: 1, limit: 1 });
  expect(r.lines).toEqual(["a.txt-1- one", "a.txt:2: two", "a.txt-3- three"]);
  expect(r.limitReached).toBe(true);
});

// ── the index ────────────────────────────────────────────────────────────────

const PATTERNS: [string, { ignoreCase?: boolean; literal?: boolean; glob?: string }][] = [
  ["parseConfig", {}],
  ["fetch.*Json", {}],
  ["colou?r", {}],
  ["TODO|FIXME", {}],
  ["todo", { ignoreCase: true }],
  ["(?i)TODO", {}],
  ["\\bparse\\w*\\(", {}],
  ["a.b", {}],
  ["parseConfig(", { literal: true }],
  ["return", { glob: "*.ts" }],
  ["return", { glob: "!*.ts" }],
  ["nothing matches this", {}],
];

test("narrowing never loses a match: the same lines as reading every file", async () => {
  const root = project(files);
  const ix = indexOf(root);
  const r = await ix.refreshText();
  expect(r).toMatchObject({ read: 6, files: 6 });
  // The binary file is known but never searched.
  expect(ix.textFiles()).toEqual(["README.md", "notes/todo.txt", "src/config.ts", "src/fetch.ts", "src/util.py"]);
  for (const [pattern, o] of PATTERNS) {
    const p = { pattern, ...o };
    const re = compile(pattern, o)!;
    const got = out(indexedGrep(ix, re, p, root));
    const every = grepLines(
      ix
        .textFiles()
        .filter((f) => !o.glob || globMatch(o.glob, f))
        .map((f) => ({ shown: f, text: fs.readFileSync(path.join(root, f), "utf8") })),
      re,
      { limit: 100 },
    ).lines.join("\n");
    expect(got, pattern).toBe(every || "No matches found");
  }
  // And it does narrow: one file of five is read for a name only it holds (all five on an
  // SQLite without the trigram tokenizer, which still answers, only slower).
  expect(indexedGrep(ix, compile("retry_backoff")!, { pattern: "retry_backoff" }, root)!.details).toMatchObject({ index: { read: ix.trigrams ? 1 : 5, of: 5 } });
});

test.skipIf(!Bun.which("rg"))("the same matching lines as ripgrep", async () => {
  const root = project(files);
  const ix = indexOf(root);
  await ix.refreshText();
  for (const [pattern, o] of PATTERNS) {
    const args = ["--line-number", "--no-heading", "--color=never", "--hidden", "--no-ignore", "--with-filename"];
    if (o.ignoreCase) args.push("-i");
    if (o.literal) args.push("-F");
    if (o.glob) args.push("--glob", o.glob);
    const rg = spawnSync("rg", [...args, "--", pattern, "."], { cwd: root, encoding: "utf8" });
    const want = rg.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^\.\//, "").replace(/^([^:]+):(\d+):/, "$1:$2: "))
      .sort();
    const got = out(indexedGrep(ix, compile(pattern, o)!, { pattern, ...o }, root));
    expect(got === "No matches found" ? [] : got.split("\n").sort(), pattern).toEqual(want);
  }
});

test("the text index follows the files: an edit, a new file and a removal; unchanged bytes are not read again", async () => {
  const root = project(files);
  const ix = indexOf(root);
  await ix.refreshText();
  fs.writeFileSync(path.join(root, "src/config.ts"), "export function loadSettings() {}\n");
  fs.writeFileSync(path.join(root, "src/new.ts"), "export const parseConfig = 1;\n");
  fs.rmSync(path.join(root, "src/fetch.ts"));
  expect(await ix.refreshText()).toMatchObject({ read: 2, removed: 1 });
  expect(out(indexedGrep(ix, compile("parseConfig")!, { pattern: "parseConfig" }, root))).toBe("src/new.ts:1: export const parseConfig = 1;");
  expect(out(indexedGrep(ix, compile("loadSettings")!, { pattern: "loadSettings" }, root))).toContain("src/config.ts:1:");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, "README.md"), later, later);
  expect((await ix.refreshText()).read).toBe(0);
});

test("a folder or a file narrows the search and names paths from there", async () => {
  const root = project(files);
  const ix = indexOf(root);
  await ix.refreshText();
  expect(out(indexedGrep(ix, /TODO/, { pattern: "TODO", path: "notes" }, root))).toBe("todo.txt:1: TODO: ship it");
  expect(out(indexedGrep(ix, /TODO/, { pattern: "TODO", path: "README.md" }, root))).toBe("README.md:3: TODO: write docs");
  // From a folder inside the project, a relative path is the agent's own.
  expect(out(indexedGrep(ix, /fetch/, { pattern: "fetch", path: "." }, path.join(root, "src")))).toContain("fetch.ts:2:");
  // Outside the project, or a folder the index holds nothing of: ripgrep's to answer.
  expect(indexedGrep(ix, /x/, { pattern: "x", path: os.tmpdir() }, root)).toBeUndefined();
  expect(indexedGrep(ix, /x/, { pattern: "x", path: "assets" }, root)).toBeUndefined();
  expect(indexedGrep(ix, /x/, { pattern: "x", path: "missing" }, root)).toBeUndefined();
});

test("files a read may not see are not in the text index", async () => {
  const root = project({ ...files, ".env": "API_KEY=sk-secret-value\n" });
  const ix = indexOf(root, (rel) => rel === ".env");
  await ix.refreshText();
  expect(ix.textFiles()).not.toContain(".env");
  expect(out(indexedGrep(ix, /secret/, { pattern: "secret" }, root))).toBe("No matches found");
});

test("more source files than the limit and the text index reads nothing", async () => {
  const root = project(files);
  const ix = new CodeIndex(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ix-")), "code.db"), root, { list: walk, maxFiles: 2 });
  cleanup.push(() => ix.close());
  expect(await ix.refreshText()).toEqual({ read: 0, removed: 0, files: 0, tooMany: 3 });
});

// ── on a session ─────────────────────────────────────────────────────────────

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });

/** Run `f` with nothing on PATH: no ripgrep (and no git, so the project's files are walked). */
async function withoutRipgrep<T>(f: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-nopath-"));
  try {
    return await f();
  } finally {
    process.env.PATH = saved;
  }
}

async function grepSession() {
  const e = await mnemoEnv({ cwd: project(files), mode: "yolo" });
  cleanup.push(() => e.close());
  const results = () =>
    e.runtime.session.messages.filter((m) => (m as { role?: string }).role === "toolResult") as unknown as { content: { text: string }[]; details: unknown; isError?: boolean }[];
  return { e, results };
}

test("grep adds no tool where it was not named; where it is and ripgrep is not installed, the index answers", async () => {
  const { e, results } = await grepSession();
  expect(e.controller.session.getActiveToolNames()).not.toContain("grep");
  e.controller.session.setActiveToolsByName([...e.controller.session.getActiveToolNames(), "grep"]);
  e.faux.setResponses([
    call("grep", { pattern: "parseConfig", path: "src" }),
    call("grep", { pattern: "[[:alpha:]]+Config" }),
    fauxAssistantMessage(fauxText("done")),
  ]);
  await withoutRipgrep(async () => {
    await e.controller.submit("where is parseConfig used");
    await e.idle();
  });
  const [found, refused] = results();
  expect(found!.isError).toBeFalsy();
  expect(found!.content[0]!.text.split("\n")).toEqual([
    "config.ts:1: export function parseConfig(raw: string) {",
    "fetch.ts:1: import { parseConfig } from './config';",
    "fetch.ts:4:   return parseConfig(await r.text());",
  ]);
  expect(found!.details).toMatchObject({ index: { of: 3 } });
  // A pattern only ripgrep reads, with no ripgrep: refused with the reason, never matched wrongly.
  expect(refused!.isError).toBe(true);
  expect(refused!.content[0]!.text).toContain("only ripgrep reads");
});

test.skipIf(!Bun.which("rg"))("with ripgrep installed, grep is ripgrep's", async () => {
  const { e, results } = await grepSession();
  e.controller.session.setActiveToolsByName([...e.controller.session.getActiveToolNames(), "grep"]);
  e.faux.setResponses([call("grep", { pattern: "[[:alpha:]]+Config\\(", path: "src" }), fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("find it");
  await e.idle();
  const [r] = results();
  expect(r!.content[0]!.text).toContain("config.ts:1: export function parseConfig(raw: string) {");
  expect(r!.details ?? {}).not.toHaveProperty("index");
});
