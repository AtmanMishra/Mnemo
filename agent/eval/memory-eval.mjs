#!/usr/bin/env node
/**
 * Phase-3b eval: same questions WITH seeded memory vs WITHOUT.
 * Usage: OPENROUTER_API_KEY=... MNEMO_MODEL=... node eval/memory-eval.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MEMSRV = path.join(ROOT, "memory-layer/target/debug/memsrv");
const JOURNAL = path.join(ROOT, "memory-layer/data/sea-agent-journal.jsonl");

function memsrv(method, params, journal, id) {
  const p = spawnSync(MEMSRV, [journal], {
    input: JSON.stringify({ id, method, params }) + "\n{" + '"id":999,"method":"exit"}\n',
    encoding: "utf8",
    timeout: 15000,
  });
  const lines = p.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return lines.find((r) => r.id === id);
}

function seedMemory(journal) {
  let id = 0;
  const call = (m, p) => memsrv(m, p, journal, ++id);
  // T1
  const ep1 = call("episode", { label: "checkout-service knowledge" }).result.episode;
  const n1 = call("create_node", { kind: "aspect", label: "checkout-service" }).result.node;
  call("link", { src: n1, dst: ep1 });
  call("fact", { node: n1, key: "package-manager", value: "pnpm" });
  // T2
  const ep2 = call("episode", { label: "port allocation notes" }).result.episode;
  const n2 = call("create_node", { kind: "aspect", label: "ports" }).result.node;
  call("link", { src: n2, dst: ep2 });
  call("fact", { node: n2, key: "port-8080", value: "taken by auth service" });
  call("fact", { node: n2, key: "port-8081", value: "free, reserved for billing" });
  // T3
  const ep3 = call("episode", { label: "helm incident" }).result.episode;
  const n3 = call("create_node", { kind: "aspect", label: "helm rollback" }).result.node;
  call("link", { src: n3, dst: ep3 });
  call("fact", { node: n3, key: "incident", value: "rollback failed because --wait flag was missing" });
}

const TASKS = [
  {
    q: "Which package manager does our checkout service use? Answer with just the tool name.",
    expect: ["pnpm"],
    seed: true,
  },
  {
    q: "Which port should the new billing service use? Answer with just the port number.",
    expect: ["8081"],
    seed: true,
  },
  {
    q: "Why did our last helm rollback fail? One short sentence.",
    expect: ["--wait", "wait flag"],
    seed: true,
  },
];

function askAgent(q, journal) {
  const r = spawnSync("node", [path.join(ROOT, "agent/bin/mnemo.ts"), q], {
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, MNEMO_MEMORY_JOURNAL: journal, SEA_MEMORY_JOURNAL: journal, SEA_CLI_FORCE: "" },
  });
  return (r.stdout || "").trim();
}

const tmp = mkdtempSync(path.join(tmpdir(), "sea-eval-"));
const seeded = path.join(tmp, "seeded.jsonl");
seedMemory(seeded);
const empty = path.join(tmp, "empty.jsonl");

console.log(`${"task".padEnd(34)} ${"WITH memory".padEnd(30)} ${"WITHOUT memory"}`);
let withOk = 0, withoutOk = 0;
TASKS.forEach((t, i) => {
  const aWith = askAgent(t.q, seeded);
  const aWithout = askAgent(t.q, empty);
  const hit = (a) => t.expect.some((e) => a.toLowerCase().includes(e.toLowerCase()));
  if (hit(aWith)) withOk++;
  if (hit(aWithout)) withoutOk++;
  console.log(
    `T${i + 1} ${t.q.slice(0, 30).padEnd(32)} ${(aWith.slice(0, 28) || "(empty)").padEnd(30)} ${(aWithout.slice(0, 28) || "(empty)")}` +
    `   [with=${hit(aWith) ? "PASS" : "FAIL"} without=${hit(aWithout) ? "PASS" : "FAIL"}]`
  );
});
console.log(`\nScore WITH memory: ${withOk}/${TASKS.length}   WITHOUT: ${withoutOk}/${TASKS.length}`);
rmSync(tmp, { recursive: true, force: true });
