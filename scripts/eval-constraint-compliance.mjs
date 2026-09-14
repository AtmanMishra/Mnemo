#!/usr/bin/env node
/**
 * Constraint-persistence probe, the behavioural half.
 *
 * The deterministic half (memory-layer/tests/constraint_probe.rs) proves the
 * graph still *recalls* a constraint stated once. This one asks the harder
 * question from docs/archive/EVAL-RESEARCH.md §3.3: given the constraint is in
 * memory, does the agent actually *comply* with it later — the half that
 * LongMemEval's QA-shaped recall tests do not cover.
 *
 * How it works: a throwaway project, a throwaway journal, constraints seeded
 * into memory, then one real agent run per scenario. Compliance is judged by a
 * deterministic rule over the agent's answer (it must name the constrained
 * tool/port/style), not by another model — a judge that can be talked into a
 * pass is not a measurement.
 *
 * Needs a provider key (OPENROUTER_API_KEY / OPENCODE_API_KEY / ANTHROPIC_API_KEY
 * or a logged-in ~/.mnemo/auth.json). Without one it exits 3 with a clear
 * message so a workflow can skip rather than fail.
 *
 *   node scripts/eval-constraint-compliance.mjs [--json <path>] [--keep]
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const AGENT = path.join(ROOT, "agent", "bin", "mnemo.ts");
const MEMSRV_NAMES = process.platform === "win32" ? ["memsrv.exe"] : ["memsrv"];

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const keep = args.includes("--keep");
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 180_000);

/** One scenario: a constraint stated once, a later task that must respect it. */
const SCENARIOS = [
  {
    name: "package manager",
    constraint: { key: "package manager", value: "this repo uses pnpm. npm and yarn are forbidden here." },
    task: "Add the dev dependency `left-pad` to this project. Answer with the single command you would run, nothing else.",
    // Compliance: names pnpm in the command it proposes. A model without the
    // constraint will say npm or yarn.
    compliant: (text) => /\bpnpm\s+(add|install|i)\b/i.test(text),
    violation: (text) => /\b(npm|yarn)\s+(install|i|add)\b/i.test(text),
  },
  {
    name: "dev server port",
    constraint: { key: "dev port", value: "the dev server in this repo listens on port 4111, never 3000." },
    task: "How do I reach the dev server from my browser? Answer with the URL only.",
    compliant: (text) => /4111/.test(text),
    violation: (text) => /:3000\b/.test(text),
  },
  {
    name: "comment style",
    constraint: { key: "comment style", value: "comments in this codebase explain WHY, never WHAT the code does." },
    task: "Write one comment for a function that retries an HTTP call three times. Output the comment only.",
    // Judged on shape, not vocabulary: a why-comment explains a reason
    // (because/so that/otherwise/to avoid) rather than narrating the loop.
    compliant: (text) => /(because|so that|otherwise|to avoid|in case|since )/i.test(text),
    violation: (text) => /^(#|\/\/|\/\*)?\s*(this |the )?(function|code|loop|method)\b/i.test(text.trim()),
  },
];

function haveKey() {
  if (process.env.OPENROUTER_API_KEY || process.env.OPENCODE_API_KEY || process.env.ANTHROPIC_API_KEY) return true;
  try {
    const home = process.env.MNEMO_HOME ?? os.homedir();
    const raw = fs.readFileSync(path.join(home, ".mnemo", "auth.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Object.values(parsed.providers ?? {}).some((p) => p?.key || p?.accessToken);
  } catch {
    return false;
  }
}

function findMemsrv() {
  if (process.env.MNEMO_MEMSRV_BIN) return process.env.MNEMO_MEMSRV_BIN;
  for (const profile of ["debug", "release"]) {
    for (const name of MEMSRV_NAMES) {
      const p = path.join(ROOT, "memory-layer", "target", profile, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** Seed the constraints into a journal through memsrv, one RPC line at a time. */
async function seed(bin, journal, constraints) {
  const child = spawn(bin, [journal], { stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const w = waiters.get(msg.id);
        if (w) { waiters.delete(msg.id); w(msg); }
      } catch { /* not our line */ }
    }
  });
  let id = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = id++;
      waiters.set(mine, resolve);
      child.stdin.write(JSON.stringify({ id: mine, method, params }) + "\n");
      setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
    });

  const node = (await call("create_node", { kind: "aspect", label: "repo conventions" })).result.node;
  for (const c of constraints) {
    const res = await call("fact", { node, key: c.key, value: c.value });
    if (res.ok !== true) throw new Error(`fact failed: ${JSON.stringify(res)}`);
  }
  child.stdin.end();
  return node;
}

/** Run the agent once, non-interactively, and return what it said. */
function ask(prompt, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT, prompt], { cwd: env.cwd, env: env.vars, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function main() {
  const memsrv = findMemsrv();
  if (!memsrv) {
    console.error("cannot find memsrv: build it (cd memory-layer && cargo build) or set MNEMO_MEMSRV_BIN");
    process.exit(2);
  }
  if (!haveKey()) {
    console.error("no provider key: set OPENROUTER_API_KEY / OPENCODE_API_KEY / ANTHROPIC_API_KEY, or log in with `mnemo auth`");
    process.exit(3); // distinct: a caller should SKIP, not fail
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-compliance-"));
  const home = path.join(work, "home");
  const journal = path.join(work, "journal.jsonl");
  const project = path.join(work, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "probe", version: "0.0.0" }, null, 2));

  await seed(memsrv, journal, SCENARIOS.map((s) => s.constraint));

  const vars = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    MNEMO_HOME: home,
    MNEMO_MEMSRV_BIN: memsrv,
    MNEMO_MEMORY_JOURNAL: journal,
  };

  const results = [];
  for (const s of SCENARIOS) {
    const { code, out, err } = await ask(s.task, { cwd: project, vars });
    const text = out.trim();
    const ok = s.compliant(text);
    const bad = s.violation(text);
    results.push({ scenario: s.name, compliant: ok, violation: bad, exit: code, answer: text.slice(0, 400), stderr: err.slice(-300) });
    console.log(`${ok && !bad ? "PASS" : "FAIL"}  ${s.name.padEnd(18)} ${ok ? "complied" : bad ? "ignored the constraint" : "inconclusive"}`);
    if (!ok) console.log(`      said: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  }

  const passed = results.filter((r) => r.compliant && !r.violation).length;
  const report = {
    probe: "constraint-compliance",
    at: new Date().toISOString(),
    model: process.env.MNEMO_MODEL ?? "(provider default)",
    scenarios: results.length,
    passed,
    results,
  };
  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
  console.log(`\n${passed}/${results.length} constraints respected later`);
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
