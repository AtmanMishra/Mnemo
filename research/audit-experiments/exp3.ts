import { MemoryClient } from "../../packages/memory/src/index.ts";
import { spawnMemsrv } from "../../packages/memory/src/index.ts";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import { findMemsrv } from "../../app/src/runtime/paths.ts";
const BIN = findMemsrv("/nonexistent") ?? (() => { throw new Error("build memsrv first: cd memory-layer && cargo build --release --bin memsrv"); })();
const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "audit3-")), "j.jsonl");
const c = new MemoryClient({ binaryPath: BIN, journalPath: journal, spawn: spawnMemsrv, timeoutMs: 120000 });
const words = "auth billing checkout deploy docker helm migration payments queue redis retry schema search session stripe tests vitest webhook worker".split(" ");
let n = 0;
for (const target of [500, 2000, 8000]) {
  const t0 = performance.now();
  while (n < target) {
    const r = await c.request("episode", { label: `task ${n}: ${words[n % words.length]} ${words[(n * 7) % words.length]} fix` });
    await c.request("fact", { node: (r.result as any).episode, key: "learned", value: `${words[(n * 3) % words.length]} uses ${words[(n * 5) % words.length]}` });
    n++;
  }
  const write = performance.now() - t0;
  const qs = ["how do we deploy with helm", "stripe webhook retry", "redis session schema", "vitest tests failing"];
  const t1 = performance.now();
  for (const q of qs) await c.request("search", { query: q, k: 5 });
  const per = (performance.now() - t1) / qs.length;
  const t2 = performance.now(); await c.request("dump"); const dump = performance.now() - t2;
  console.log(`${target} nodes: search ${per.toFixed(0)} ms/query (cache miss) · dump ${dump.toFixed(0)} ms · journal ${(fs.statSync(journal).size / 1024).toFixed(0)} KB · avg write ${(write / (target)).toFixed(2)} ms`);
}
const t3 = performance.now(); const fresh = new MemoryClient({ binaryPath: BIN, journalPath: journal, spawn: spawnMemsrv, timeoutMs: 120000 }); await fresh.request("ping"); console.log(`startup replay of ${n} nodes: ${(performance.now() - t3).toFixed(0)} ms`);
c.stop(); fresh.stop();
