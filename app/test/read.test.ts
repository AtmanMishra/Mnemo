/**
 * The join, tested on a fake client and then on the real sidecar.
 *
 * The integration half writes an episode through the client and reads it back
 * through this function, because "the panel shows what memory holds" is a claim
 * about two processes and a journal, not about a formatter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readMemory, type MemoryReader } from "../src/memory/read.ts";
import { MemoryClient, type MemoryChild } from "../src/memory/client.ts";

const answer = (response: { ok: boolean; result?: unknown; error?: string }): MemoryReader => ({
  request: async () => response,
});

test("a sidecar that answers shows what it holds", async () => {
  const summary = await readMemory(answer({ ok: true, result: { nodes: [{ label: "the rebuild" }] } }));
  assert.equal(summary.failed, false);
  assert.match(summary.lines.join("\n"), /memory: 1 node/);
  assert.match(summary.lines.join("\n"), /the rebuild/);
});

test("a sidecar that cannot answer gives the reason and names the fix", async () => {
  const summary = await readMemory(answer({ ok: false, error: "ENOENT: no such file memsrv.exe" }));
  assert.equal(summary.failed, true);
  const text = summary.lines.join("\n");
  assert.match(text, /did not answer/);
  assert.match(text, /ENOENT/, "the reason it gave, carried through rather than paraphrased");
  assert.match(text, /mnemo doctor/, "and where to look next");
});

test("a failure with no reason still says something actionable", async () => {
  const summary = await readMemory(answer({ ok: false }));
  assert.match(summary.lines.join("\n"), /no reason given/);
  assert.match(summary.lines.join("\n"), /mnemo doctor/);
});

// ---------------------------------------------------------------------------
// Against the real binary.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MEMSRV = process.env.MNEMO_MEMSRV_BIN ?? path.join(
  REPO_ROOT,
  "memory-layer",
  "target",
  "debug",
  process.platform === "win32" ? "memsrv.exe" : "memsrv",
);
const haveMemsrv = fs.existsSync(MEMSRV);
if (!haveMemsrv) console.log(`# no memsrv at ${MEMSRV} — the integration test is skipped, not passed`);

test("the real sidecar: what was written is what the panel shows", { skip: !haveMemsrv }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-read-"));
  const children: MemoryChild[] = [];
  const client = new MemoryClient({
    binaryPath: MEMSRV,
    journalPath: path.join(dir, "journal.jsonl"),
    spawn: (binary, args) => {
      const child = spawn(binary, args) as unknown as MemoryChild;
      children.push(child);
      return child;
    },
  });

  try {
    const empty = await readMemory(client);
    assert.equal(empty.failed, false, "an untouched journal is empty, not broken");
    assert.match(empty.lines.join("\n"), /memory: empty/);

    const episode = await client.request("episode", { label: "the panel proves itself" });
    assert.equal(episode.ok, true, episode.error ?? "the sidecar refused the call");

    const filled = await readMemory(client);
    assert.equal(filled.total, 1);
    assert.match(filled.lines.join("\n"), /the panel proves itself/);
  } finally {
    client.stop();
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
