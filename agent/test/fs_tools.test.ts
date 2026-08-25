import { test, beforeEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileTool, writeFileTool, applyEditTool, globListTool, setWorkspaceRoot } from "../src/tools/index.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sea-fs-"));
  setWorkspaceRoot(tmp);
});

test("write_file creates parents and writes content", async () => {
  const res = await writeFileTool.execute("w1", { path: "a/b/c.txt", content: "line1\nline2\nline3\n" });
  const onDisk = await fs.readFile(path.join(tmp, "a/b/c.txt"), "utf8");
  assert.equal(onDisk, "line1\nline2\nline3\n");
  assert.match(res.content[0].text, /Wrote/);
});

test("read_file returns full text and line slices", async () => {
  await fs.writeFile(path.join(tmp, "f.txt"), "one\ntwo\nthree\nfour\n", "utf8");
  const full = await readFileTool.execute("r1", { path: "f.txt" });
  assert.match(full.content[0].text, /^one\ntwo\nthree\nfour$/);
  const sliced = await readFileTool.execute("r2", { path: "f.txt", offset: 2, limit: 2 });
  assert.equal(sliced.content[0].text, "two\nthree");
  assert.equal((sliced.details as any).truncated, true);
});

test("read_file errors on missing file", async () => {
  await assert.rejects(() => readFileTool.execute("r3", { path: "nope.txt" }), /cannot read/);
});

test("apply_edit replaces exact unique match", async () => {
  await fs.writeFile(path.join(tmp, "e.txt"), "hello world\n", "utf8");
  await applyEditTool.execute("e1", { path: "e.txt", old_str: "world", new_str: "sea" });
  assert.equal(await fs.readFile(path.join(tmp, "e.txt"), "utf8"), "hello sea\n");
});

test("apply_edit fails when old_str not found", async () => {
  await fs.writeFile(path.join(tmp, "e.txt"), "hello\n", "utf8");
  await assert.rejects(
    () => applyEditTool.execute("e2", { path: "e.txt", old_str: "zzz", new_str: "y" }),
    /not found/,
  );
});

test("apply_edit fails on ambiguous match without replace_all", async () => {
  await fs.writeFile(path.join(tmp, "e.txt"), "x x x\n", "utf8");
  await assert.rejects(
    () => applyEditTool.execute("e3", { path: "e.txt", old_str: "x", new_str: "y" }),
    /appears 3 times/,
  );
  // replace_all succeeds
  await applyEditTool.execute("e4", { path: "e.txt", old_str: "x", new_str: "y", replace_all: true });
  assert.equal(await fs.readFile(path.join(tmp, "e.txt"), "utf8"), "y y y\n");
});

test("glob_list matches relative patterns under root", async () => {
  await fs.mkdir(path.join(tmp, "src/sub"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src/a.ts"), "", "utf8");
  await fs.writeFile(path.join(tmp, "src/sub/b.ts"), "", "utf8");
  await fs.writeFile(path.join(tmp, "README.md"), "", "utf8");
  const res = await globListTool.execute("g1", { pattern: "src/**/*.ts" });
  const lines = res.content[0].text.split("\n").sort();
  assert.deepEqual(lines.sort(), ["src/a.ts", "src/sub/b.ts"]);
  const none = await globListTool.execute("g2", { pattern: "*.xyz" });
  assert.equal(none.content[0].text, "(no matches)");
});
