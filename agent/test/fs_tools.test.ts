import { test, beforeEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileTool, writeFileTool, applyEditTool, globListTool, setWorkspaceRoot } from "../src/tools/index.ts";
import { textOf } from "../src/tools/types.ts";
import { resolveInWorkspace } from "../src/tools/workspace.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sea-fs-"));
  setWorkspaceRoot(tmp);
});

test("write_file creates parents and writes content", async () => {
  const res = await writeFileTool.execute("w1", { path: "a/b/c.txt", content: "line1\nline2\nline3\n" });
  const onDisk = await fs.readFile(path.join(tmp, "a/b/c.txt"), "utf8");
  assert.equal(onDisk, "line1\nline2\nline3\n");
  assert.match(textOf(res), /Wrote/);
});

test("read_file returns full text and line slices", async () => {
  await fs.writeFile(path.join(tmp, "f.txt"), "one\ntwo\nthree\nfour\n", "utf8");
  const full = await readFileTool.execute("r1", { path: "f.txt" });
  assert.match(textOf(full), /^one\ntwo\nthree\nfour$/);
  const sliced = await readFileTool.execute("r2", { path: "f.txt", offset: 2, limit: 2 });
  assert.equal(textOf(sliced), "two\nthree");
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
  const lines = textOf(res).split("\n").sort();
  assert.deepEqual(lines.sort(), ["src/a.ts", "src/sub/b.ts"]);
  const none = await globListTool.execute("g2", { pattern: "*.xyz" });
  assert.equal(textOf(none), "(no matches)");
});

// --- 12.6 (e00cd116): the workspace root is a real jail ---------------------

test("resolveInWorkspace rejects absolute paths outside the root", async () => {
  // A relative target resolves to the canonical root + name, even if the file
  // does not exist yet. Canonicalize BOTH sides: %TEMP% can be handed out in
  // its 8.3 short form (C:\Users\ATMANM~1\...) while the expected path is long
  // form, and realpath does not spell the two the same way — the comparison
  // must be between two canonical paths, not two spellings of one. The tail
  // may not exist, so canonicalize the (existing) directory and rejoin it.
  const canon = await fs.realpath(tmp);
  const canonical = async (p: string) =>
    path.join(await fs.realpath(path.dirname(p)), path.basename(p));
  assert.equal(await canonical(resolveInWorkspace("in.txt")), path.join(canon, "in.txt"));
  // sanity: the root itself is inside
  assert.equal(await canonical(resolveInWorkspace(".")), canon);
  for (const outside of ["/etc/hosts", "/etc"]) {
    assert.throws(() => resolveInWorkspace(outside), /outside the workspace root/,
      `${outside} must be rejected`);
  }
});

test("resolveInWorkspace rejects ../ walks that escape the root", () => {
  assert.throws(() => resolveInWorkspace("../escape.txt"), /outside the workspace root/);
  assert.throws(() => resolveInWorkspace("a/../../escape.txt"), /outside the workspace root/);
  // ...but a walk that stays inside resolves fine
  assert.doesNotThrow(() => resolveInWorkspace("a/../b.txt"));
});

test("file tools refuse to read and write outside the root", async () => {
  await fs.writeFile(path.join(tmp, "secret.txt"), "top secret", "utf8");
  // read via a ../ walk and via an absolute path
  await assert.rejects(
    () => readFileTool.execute("j1", { path: "../sea-fs-x/secret.txt" }),
    /outside the workspace root/,
  );
  await assert.rejects(
    () => readFileTool.execute("j2", { path: "/etc/hosts" }),
    /outside the workspace root/,
  );
  // writes are jailed the same way, for new and existing targets
  await assert.rejects(
    () => writeFileTool.execute("j3", { path: "../pwned.txt", content: "x" }),
    /outside the workspace root/,
  );
  await assert.rejects(
    () => writeFileTool.execute("j4", { path: "/tmp/mnemo-pwned.txt", content: "x" }),
    /outside the workspace root/,
  );
  await assert.rejects(
    () => applyEditTool.execute("j5", { path: "/etc/hosts", old_str: "a", new_str: "b" }),
    /outside the workspace root/,
  );
});

test("a symlink that escapes the root is not followed", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sea-outside-"));
  try {
    await fs.writeFile(path.join(outside, "keys.txt"), "PRIVATE", "utf8");
    // escape via a symlinked FILE (read)
    await fs.symlink(path.join(outside, "keys.txt"), path.join(tmp, "leak.txt"));
    await assert.rejects(
      () => readFileTool.execute("s1", { path: "leak.txt" }),
      /outside the workspace root/,
    );
    // escape via a symlinked DIRECTORY (read + write into it)
    await fs.symlink(outside, path.join(tmp, "dirlink"));
    await assert.rejects(
      () => readFileTool.execute("s2", { path: "dirlink/keys.txt" }),
      /outside the workspace root/,
    );
    await assert.rejects(
      () => writeFileTool.execute("s3", { path: "dirlink/new.txt", content: "x" }),
      /outside the workspace root/,
    );
    // a NEW file under a symlinked dir is caught too (realpath of the ancestor)
    await assert.rejects(
      () => writeFileTool.execute("s4", { path: "dirlink/deeper/new.txt", content: "x" }),
      /outside the workspace root/,
    );
    // glob_list's custom root is jailed identically
    await assert.rejects(
      () => globListTool.execute("s5", { pattern: "*", root: outside }),
      /outside the workspace root/,
    );
    // a symlink pointing INSIDE the root still works
    await fs.writeFile(path.join(tmp, "real.txt"), "hello", "utf8");
    await fs.symlink(path.join(tmp, "real.txt"), path.join(tmp, "inlink.txt"));
    const res = await readFileTool.execute("s6", { path: "inlink.txt" });
    assert.equal(textOf(res), "hello");
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});
