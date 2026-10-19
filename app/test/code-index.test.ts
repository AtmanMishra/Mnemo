/**
 * The code index: what the extractor reads in each language, how calls are tied to the
 * definitions they mean (and when they are not), that it stays fresh, what it never reads,
 * and the four tools and the edit hint on a real session.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { extract, typeName } from "../src/code/extract.ts";
import { CodeIndex, resolveImport, words } from "../src/code/index.ts";
import { parsers } from "../src/code/languages.ts";
import { judge } from "../src/extensions/policy.ts";
import { defaults, SettingsStore } from "../src/runtime/settings.ts";
import { mnemoEnv } from "./helpers.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-code-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return fs.realpathSync(dir);
}

function walk(root: string, dir = root): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(root, full) : [path.relative(root, full).split(path.sep).join("/")];
  });
}

function indexOf(root: string): CodeIndex {
  const ix = new CodeIndex(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ix-")), "code.db"), root, { list: walk });
  cleanup.push(() => ix.close());
  return ix;
}

const run = async (lang: Parameters<typeof extract>[1], src: string) => extract((await parsers()).get(lang)!, lang, src);

// ── extraction ───────────────────────────────────────────────────────────────

test("TypeScript: definitions, and a call's receiver typed from new, annotations and constructor fields", async () => {
  const r = await run(
    "typescript",
    [
      'import { helper } from "./util";',
      "export class Cache extends Base implements Store {",
      "  constructor(private disk: Disk) { super(); }",
      "  get(k: string): number { const s = new Stats(); s.hit(); this.disk.read(k); return helper(k); }",
      "}",
      "export const load = (c: Cache) => c.get('a');",
    ].join("\n"),
  );
  expect(r.definitions.map((d) => `${d.kind} ${d.qname}`)).toEqual(["class Cache", "method Cache.constructor", "method Cache.get", "function load"]);
  expect(r.definitions.find((d) => d.qname === "Cache.get")!.signature).toBe("get(k: string): number");
  const calls = r.references.filter((x) => x.kind === "call").map((x) => `${x.from}→${x.recvType ? `${x.recvType}.` : ""}${x.name}`);
  expect(calls).toEqual(expect.arrayContaining(["Cache.get→Stats", "Cache.get→Stats.hit", "Cache.get→Disk.read", "Cache.get→helper", "load→Cache.get"]));
  expect(r.references.filter((x) => x.kind !== "call").map((x) => `${x.kind} ${x.name}`)).toEqual(["import ./util", "extends Base", "implements Store"]);
});

test("Python, Rust and Go: methods belong to their type, and self, fields and locals type the receiver", async () => {
  const py = await run("python", "class C(B):\n    def __init__(self, s: Store):\n        self.s = s\n    def get(self):\n        x = Foo()\n        x.run()\n        self.s.put()\n        return self.size()\n");
  expect(py.definitions.map((d) => `${d.kind} ${d.qname}`)).toEqual(["class C", "method C.__init__", "method C.get"]);
  expect(py.references.filter((x) => x.member).map((x) => `${x.recvType}.${x.name}`)).toEqual(["Foo.run", "Store.put", "C.size"]);

  const rs = await run("rust", "pub struct S { st: Store }\nimpl Tr for S { fn m(&self, v: &Foo) { let x = Bar::new(); x.go(); v.run(); self.st.put(); } }\n");
  expect(rs.definitions.map((d) => `${d.kind} ${d.qname}`)).toEqual(["struct S", "method S.m"]);
  expect(rs.references.filter((x) => x.member).map((x) => `${x.recvType}.${x.name}`)).toEqual(["Bar.new", "Bar.go", "Foo.run", "Store.put"]);
  expect(rs.references.find((x) => x.kind === "implements")).toMatchObject({ from: "S", name: "Tr" });

  const go = await run("go", "package p\ntype S struct { st *Store }\nfunc (s *S) M(f *Foo) { x := &Bar{}; x.Go(); s.st.Put(); f.Run(); fmt.Println() }\n");
  expect(go.definitions.map((d) => `${d.kind} ${d.qname}`)).toEqual(["struct S", "method S.M"]);
  expect(go.references.filter((x) => x.member).map((x) => `${x.recvType}.${x.name}`)).toEqual(["Bar.Go", "Store.Put", "Foo.Run", ".Println"]);
});

test("a type name is the named type, whatever wraps it", () => {
  expect(["&mut Vec<Foo>", "*pkg.Store", "Store[]", ": Map<string, number>", "readonly Item[]", "Foo | null", "std::io::Error"].map(typeName)).toEqual([
    "Vec",
    "Store",
    "Store",
    "Map",
    "Item",
    "Foo",
    "Error",
  ]);
  expect(words("getUserName parse_HTTPResponse")).toBe("get user name parse http response");
});

test("imports resolve to files of the project: relative TS (with or without .js), Python modules", () => {
  const files = new Set(["src/a.ts", "src/util/index.ts", "pkg/mod.py", "pkg/sub/__init__.py"]);
  expect(resolveImport("src/b.ts", "./a.js", files)).toBe("src/a.ts");
  expect(resolveImport("src/b.ts", "./util", files)).toBe("src/util/index.ts");
  expect(resolveImport("src/b.ts", "react", files)).toBeUndefined();
  expect(resolveImport("pkg/x.py", ".mod", files)).toBe("pkg/mod.py");
  expect(resolveImport("main.py", "pkg.sub", files)).toBe("pkg/sub/__init__.py");
});

// ── tying calls to definitions ───────────────────────────────────────────────

const app = {
  "src/store.ts": "export class Store { put(k: string) { return k; } }\nexport function save(s: Store) { s.put('x'); }\n",
  "src/other.ts": "export class Other { put(k: string) { return k; } }\n",
  "src/use.ts": "import { save } from './store';\nexport function main() { save(new Store()); unknownThing(); }\nfunction local() { main(); }\n",
  "src/dup1.ts": "export function make() {}\n",
  "src/dup2.ts": "export function make() {}\n",
  "src/call.ts": "export function go(x: any) { make(); x.put('y'); }\n",
  "cmd/main.go": "package main\nfunc run() { make(map[string]int) }\n",
};

test("a call is tied when the code says which definition: same file, import, typed receiver; otherwise counted", async () => {
  const ix = indexOf(project(app));
  await ix.refresh();
  const put = ix.lookup("Store.put")[0]!;
  const callers = ix.callers(put);
  // `s.put` in save is typed; `x.put` on an `any` cannot be told from Other.put, so it is counted, not tied.
  expect(callers.edges.map((e) => `${e.from?.qname} ${e.confidence}`)).toEqual(["save exact"]);
  expect(callers.untied).toBe(1);

  const save = ix.lookup("save")[0]!;
  expect(ix.callers(save).edges.map((e) => `${e.path} ${e.from?.qname} ${e.confidence}`)).toEqual(["src/use.ts main exact"]);
  const main = ix.callees(ix.lookup("main")[0]!);
  expect(main.edges.map((e) => `${e.to.qname} ${e.confidence}`)).toEqual(["save exact", "Store exact"]);
  expect(main.untied).toEqual(["unknownThing"]);

  // Two `make`s in TypeScript: neither is guessed. And Go's builtin make never reaches TypeScript.
  for (const d of ix.lookup("make")) {
    const r = ix.callers(d);
    expect(r.edges).toEqual([]);
    expect(r.edges.some((e) => e.path.endsWith(".go"))).toBe(false);
  }
});

test("a type's callers include what extends and implements it", async () => {
  const ix = indexOf(project({ "a.ts": "export interface Shape { area(): number }\n", "b.ts": "import { Shape } from './a';\nclass Sq implements Shape { area() { return 1; } }\n" }));
  await ix.refresh();
  expect(ix.callers(ix.lookup("Shape")[0]!).edges.map((e) => `${e.kind} ${e.from?.qname} ${e.confidence}`)).toEqual(["implements Sq exact"]);
});

// ── freshness ────────────────────────────────────────────────────────────────

const dump = (ix: CodeIndex, files: string[]) => files.flatMap((f) => ix.fileDefs(f).map((d) => `${d.path} ${d.qname} ${d.line} ${d.hash}`));

test("an incremental refresh ends where a cold build does; unchanged bytes are not parsed again", async () => {
  const root = project(app);
  const ix = indexOf(root);
  expect((await ix.refresh()).read).toBe(7);
  fs.writeFileSync(path.join(root, "src/store.ts"), "export class Store {\n  put(k: string) { return k + 1; }\n  drop() {}\n}\n");
  fs.rmSync(path.join(root, "src/dup2.ts"));
  fs.writeFileSync(path.join(root, "src/new.py"), "def fresh():\n    return 1\n");
  const r = await ix.refresh();
  expect(r).toMatchObject({ read: 2, removed: 1 });
  const cold = indexOf(root);
  await cold.refresh();
  const files = walk(root);
  expect(dump(ix, files)).toEqual(dump(cold, files));
  // Same bytes, new mtime (a checkout, a touch): stat moves, nothing is parsed.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, "src/use.ts"), later, later);
  expect((await ix.refresh()).read).toBe(0);
});

// ── the tools, on a session ──────────────────────────────────────────────────

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });

async function session(files: Record<string, string>, o: { settings?: SettingsStore; home?: string; linked?: boolean } = {}) {
  let cwd = project(files);
  if (o.linked) {
    // A second spelling of the project, as Windows 8.3 names and macOS /var give one.
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-link-")), "p");
    fs.symlinkSync(cwd, link, "junction");
    cwd = link;
  }
  const e = await mnemoEnv({ cwd, mode: "yolo", settings: o.settings, home: o.home });
  cleanup.push(() => e.close());
  const results = () => e.runtime.session.messages.filter((m) => (m as { role?: string }).role === "toolResult").map((m) => JSON.stringify((m as { content: unknown }).content));
  return { e, cwd, results };
}

test("the four tools answer from the index, and an edit says who calls what it changed", async () => {
  const { e, results } = await session(app, { linked: true });
  e.faux.setResponses([
    call("code_search", { query: "store put" }),
    call("code_refs", { name: "save", direction: "callers" }),
    call("code_symbol", { path: "src/store.ts" }),
    call("code_map", {}),
    call("edit", { path: "src/store.ts", edits: [{ oldText: "s.put('x');", newText: "s.put('y');" }] }),
    fauxAssistantMessage(fauxText("done")),
  ]);
  await e.controller.submit("look around");
  await e.idle();
  const [search, refs, outline, map, edit] = results();
  expect(search).toContain("method Store.put  src/store.ts:1");
  expect(refs).toContain("main  src/use.ts:2");
  expect(outline).toContain("1: class Store\\n  1: put(k: string)");
  expect(map).toContain("files indexed");
  expect(edit).toContain("save ← main  src/use.ts:2");
});

test("files a read may not see are never indexed: credentials and paths a deny rule covers", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-home-"));
  fs.writeFileSync(path.join(home, "permissions.json"), JSON.stringify({ rules: [{ tool: "read", pattern: "private/*", action: "deny" }] }));
  const { e, results } = await session(
    { ".env.js": "export function leakedSecretLoader() {}\n", "private/keys.ts": "export function hiddenKeyMaker() {}\n", "ok.ts": "export function visibleThing() {}\n" },
    { home },
  );
  e.faux.setResponses([call("code_search", { query: "leaked secret loader hidden key maker visible thing" }), fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("search");
  await e.idle();
  const [out] = results();
  expect(out).toContain("visibleThing");
  expect(out).not.toContain("leakedSecretLoader");
  expect(out).not.toContain("hiddenKeyMaker");
});

test("off in the settings, there are no code tools", async () => {
  const off = new SettingsStore({ ...defaults(), codeIndex: false });
  const { e } = await session({ "a.ts": "export function a() {}\n" }, { settings: off });
  const names = e.controller.session.getAllTools().map((t) => t.name);
  expect(names).not.toContain("code_search");
  const on = await session({ "a.ts": "export function a() {}\n" });
  expect(on.e.controller.session.getAllTools().map((t) => t.name)).toEqual(expect.arrayContaining(["code_search", "code_symbol", "code_refs", "code_map"]));
});

test("the gate: code tools are reads, plan mode included, and a path to credentials is refused", () => {
  const noGrants = { project: [], global: [], deny: [] };
  for (const tool of ["code_search", "code_refs", "code_symbol", "code_map"]) expect(judge({ mode: "plan" }, [], noGrants, "/p", tool, { name: "x" })).toEqual({ allow: true });
  const v = judge({ mode: "default" }, [], noGrants, "/p", "code_symbol", { path: path.join(os.homedir(), ".ssh", "id_rsa") });
  expect(v).toMatchObject({ allow: false });
});
