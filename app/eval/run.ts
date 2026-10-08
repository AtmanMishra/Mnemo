#!/usr/bin/env bun
/**
 * Run the memory experiments and write a report.
 *
 *   bun eval/run.ts                         every scenario, with and without memory,
 *                                           on opencode-go/deepseek-v4.1-flash
 *   bun eval/run.ts --scenario pitfall-learned
 *   bun eval/run.ts --model opencode/deepseek-v4.1-flash --repeat 3
 *   bun eval/run.ts --memory-only           skip the baseline
 *   bun eval/run.ts --faux                  the harness itself, no model (CI)
 *
 * Needs OPENCODE_API_KEY (and opencode.ai reachable) for a real model, and a
 * built memsrv. Results: eval/results/<timestamp>/{report.md,results.json}.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxModel, realModel } from "./harness.ts";
import { runScenario, type RunResult } from "./experiment.ts";
import { SCENARIOS } from "./scenarios.ts";

interface Args {
  model: string;
  scenario?: string;
  repeat: number;
  baseline: boolean;
  faux: boolean;
  out: string;
}

function parse(argv: string[]): Args {
  const a: Args = {
    model: process.env.MNEMO_EVAL_MODEL ?? "opencode-go/deepseek-v4.1-flash",
    repeat: 1,
    baseline: true,
    faux: false,
    out: path.join(import.meta.dir, "results", new Date().toISOString().replace(/[:.]/g, "-")),
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--model") a.model = argv[++i]!;
    else if (v === "--scenario") a.scenario = argv[++i];
    else if (v === "--repeat") a.repeat = Number(argv[++i]);
    else if (v === "--memory-only") a.baseline = false;
    else if (v === "--faux") a.faux = true;
    else if (v === "--out") a.out = argv[++i]!;
    else throw new Error(`unknown argument ${v}`);
  }
  return a;
}

function report(results: RunResult[], args: Args): string {
  const lines = [
    `# Mnemo memory experiments`,
    "",
    `model \`${args.faux ? "faux" : args.model}\` · ${new Date().toISOString()} · repeat ${args.repeat}`,
    "",
    "| scenario | check | kind | with memory | without |",
    "|---|---|---|---|---|",
  ];
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  for (const s of scenarios) {
    const names = [...new Set(results.filter((r) => r.scenario === s).flatMap((r) => r.checks.map((c) => `${c.kind}\u0000${c.name}`)))];
    for (const key of names) {
      const [kind, name] = key.split("\u0000") as [string, string];
      const tally = (memory: boolean) => {
        // A contaminated run is evidence of nothing but its contamination.
        const clean = (r: RunResult) => kind === "integrity" || r.checks.every((c) => c.kind !== "integrity" || c.pass);
        const runs = results.filter((r) => r.scenario === s && r.memory === memory && clean(r));
        const hits = runs.flatMap((r) => r.checks.filter((c) => c.name === name));
        if (!hits.length) return "—";
        return `${hits.filter((c) => c.pass).length}/${hits.length}`;
      };
      lines.push(`| ${s} | ${name} | ${kind} | ${tally(true)} | ${tally(false)} |`);
    }
  }
  const cost = results.reduce((n, r) => n + r.cost, 0);
  lines.push("", `total model cost: $${cost.toFixed(4)} · total time ${(results.reduce((n, r) => n + r.ms, 0) / 60000).toFixed(1)} min`, "");
  lines.push("## Failures, with evidence", "");
  for (const r of results)
    for (const c of r.checks.filter((c) => !c.pass))
      lines.push(`- **${r.scenario}** (${r.memory ? "memory" : "baseline"}, run ${r.repeat}) — ${c.name}: ${c.detail?.replace(/\n/g, " ⏎ ")}`);
  lines.push("", "## What memory showed in each session", "");
  for (const r of results.filter((r) => r.memory))
    r.sessions.forEach((s, i) => {
      if (s.memory.length) lines.push(`- ${r.scenario} s${i + 1}: ${s.memory.join(" ‖ ").slice(0, 600)}`);
    });
  return lines.join("\n") + "\n";
}

const args = parse(process.argv.slice(2));
const scenarios = SCENARIOS.filter((s) => !args.scenario || s.name === args.scenario);
if (!scenarios.length) throw new Error(`no scenario ${args.scenario}; have: ${SCENARIOS.map((s) => s.name).join(", ")}`);
const makeModel = args.faux ? fauxModel : (dir: string) => realModel(dir, args.model);
// Fail fast on a missing key, before building anything.
if (!args.faux) await realModel(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-eval-probe-")), args.model);
console.log(`model ${args.faux ? "faux" : args.model} · ${scenarios.length} scenario(s) · repeat ${args.repeat}${args.baseline ? " · with baseline" : ""}`);
const results: RunResult[] = [];
for (let i = 1; i <= args.repeat; i++)
  for (const s of scenarios) {
    results.push(await runScenario(s, true, i, makeModel));
    if (args.baseline) results.push(await runScenario(s, false, i, makeModel));
  }
fs.mkdirSync(args.out, { recursive: true });
fs.writeFileSync(path.join(args.out, "results.json"), JSON.stringify({ args, results }, null, 2));
const md = report(results, args);
fs.writeFileSync(path.join(args.out, "report.md"), md);
console.log(`\n${md}\nwritten to ${args.out}`);
process.exit(0);
