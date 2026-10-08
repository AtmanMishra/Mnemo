// Simulate what the app's memory extension does over several sessions, then inspect.
import { MemoryService } from "../../app/src/memory/service.ts";
import { MemoryClient } from "../../app/src/memory/client.ts";
import { spawnMemsrv } from "../../app/src/memory/service.ts";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import { findMemsrv } from "../../app/src/runtime/paths.ts";
const BIN = findMemsrv("/nonexistent") ?? (() => { throw new Error("build memsrv first: cd memory-layer && cargo build --release --bin memsrv"); })();
const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "audit-")), "j.jsonl");
const mem = new MemoryService(BIN, journal);
const raw = new MemoryClient({ binaryPath: BIN, journalPath: journal, spawn: spawnMemsrv });
const cwd = "/work/shop";
// Session-level facts, as reflection would write them
await mem.learn("project", cwd, "package manager", "pnpm");
await mem.learn("project", cwd, "test command", "pnpm vitest run");
await mem.learn("project", cwd, "dev server port", "4111");
await mem.learn("user", cwd, "comment style", "explain why, not what");
// 6 sessions: each an episode; recall hits linked; some tool failures steer
const tasks = [
  ["fix the checkout total rounding bug", "bash failed: Error: vitest not found, run pnpm install"],
  ["add retry to payment client", "edit failed: oldText not found in src/pay.ts"],
  ["run the tests for checkout", "bash failed: Error: vitest not found, run pnpm install"],
  ["update the README install section", null],
  ["deploy staging", "bash failed: fly: command not found"],
  ["run the tests for payments", "bash failed: Error: vitest not found, run pnpm install"],
];
for (const [task, failure] of tasks) {
  const hits = await mem.recall(task!, cwd);
  const ep = (await mem.episode(`task: ${task}`))!;
  for (const h of hits) await mem.link(h.node, ep);
  await mem.log(ep, "tool_call", "bash: ok");
  if (failure) { const r = await mem.steer(ep, failure); console.log("steer", task, "->", JSON.stringify(r)); }
  else await mem.good(ep, "run completed without errors");
}
const lessons = await raw.request("consolidate");
console.log("consolidate:", JSON.stringify(lessons.result, null, 0).slice(0, 800));
const dump = await raw.request("dump");
const nodes = (dump.result as any).nodes;
console.log("\nNODES", nodes.length);
for (const n of nodes) console.log(`  #${n.id} ${n.kind}/${n.area} "${n.label}" facts=${n.facts} feeders=${n.feeders}`);
for (const q of ["how do I run the tests", "vitest not found", "what port does the dev server use", "how do we deploy"]) {
  const hits = await mem.search(q, 5);
  console.log(`\nSEARCH "${q}"`); for (const h of hits) console.log(`  ${h.score.toFixed(3)} ${h.kind}/${h.area} ${h.label}`);
  const rec = await mem.recall(q, cwd);
  console.log(`  recall() would inject: ${rec.map((h) => h.label).join(" | ") || "(nothing)"}`);
}
const st = await raw.request("state", { node: 1 });
console.log("\nSTATE #1 (raw):", JSON.stringify((st.result as any).state));
mem.stop(); raw.stop();
