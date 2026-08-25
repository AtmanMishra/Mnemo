import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  saveSession,
  loadSession,
  listSessions,
  exportSession,
  importSession,
} from "../src/skills/store.ts";

test("save/list/load roundtrip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sea-sess-"));
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
    { role: "user", content: "bye" },
  ];
  const file = await saveSession(dir, "run-01", messages);
  assert.equal(file, path.join(dir, "run-01.jsonl"));

  const loaded = await loadSession(dir, "run-01");
  assert.deepEqual(loaded, messages);

  const summaries = await listSessions(dir);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].name, "run-01");
  assert.equal(summaries[0].file, file);
  assert.equal(summaries[0].messageCount, 3);
  assert.ok(summaries[0].mtime instanceof Date);
});

test("listSessions sorts newest first and tolerates empty dir", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "sea-empty-"));
  assert.deepEqual(await listSessions(empty), []);
  assert.deepEqual(await listSessions(path.join(empty, "does-not-exist")), []);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sea-sort-"));
  await saveSession(dir, "old", [{ role: "user", content: "a" }]);
  await new Promise((r) => setTimeout(r, 20));
  await saveSession(dir, "new", [{ role: "user", content: "b" }]);
  const names = (await listSessions(dir)).map((s) => s.name);
  assert.deepEqual(names, ["new", "old"]);
});

test("exportSession/importSession roundtrip via arbitrary path", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sea-exp-"));
  const file = path.join(tmp, "sub", "transcript.jsonl");
  const messages = [
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ];
  await exportSession(file, messages);
  assert.deepEqual(await importSession(file), messages);
});

test("load skips blank and malformed lines", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sea-junk-"));
  const file = path.join(tmp, "junk.jsonl");
  await fs.writeFile(
    file,
    '\n{"role":"user","content":"ok"}\n{not json}\n{"role":"assistant"}\n{"role":"system","content":"fine"}\n',
    "utf8",
  );
  assert.deepEqual(await importSession(file), [
    { role: "user", content: "ok" },
    { role: "system", content: "fine" },
  ]);
});

test("rejects unsafe session names", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sea-name-"));
  await assert.rejects(() => saveSession(dir, "../escape", []), /invalid session name/);
  await assert.rejects(() => loadSession(dir, ""), /invalid session name/);
});
