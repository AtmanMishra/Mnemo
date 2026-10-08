#!/usr/bin/env bun
/**
 * The learning curve: one repository, many tasks in a row.
 *
 * A small money library with house rules nobody writes down — amounts are
 * integer cents, every function is exported from the index, every change gets
 * a changelog line — and a build step the tests need (`npm run gen`), which a
 * fresh checkout lacks. Only the first task states the rules; after that only
 * memory carries them. Each task is scored by hidden tests (written at check
 * time, deleted after, so no session can read them) on the new feature, every
 * earlier feature, and the rules.
 *
 * Modes, each over the same tasks:
 *   baseline   the student model, no memory
 *   memory     the student model, with memory
 *   teacher    the teacher model for the first half, the student after —
 *              memory carries what the stronger model learned (with --teacher)
 *
 *   bun eval/series.ts [--model provider/id] [--teacher provider/id] [--repeat n] [--modes a,b]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { realModel, runSession, type EvalModel, type SessionResult } from "./harness.ts";
import { contamination } from "./experiment.ts";

const write = (dir: string, file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
};

export function buildRepo(dir: string): void {
  write(dir, "package.json", JSON.stringify({ name: "till", version: "0.1.0", private: true, type: "module", scripts: { gen: "node scripts/gen.mjs", test: "node scripts/check-gen.mjs && node --test" } }, null, 2) + "\n");
  write(dir, "README.md", "# till\n\nSmall money helpers for the shop.\n");
  write(dir, "CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- First release: sumCents.\n");
  write(dir, ".gitignore", "src/generated/\nnode_modules/\n");
  write(
    dir,
    "scripts/gen.mjs",
    `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("src/generated", { recursive: true });\n` +
      `writeFileSync("src/generated/rates.mjs", "export const RATES = { USD: 1, EUR: 0.9, GBP: 0.8 };\\nexport const TAX = { standard: 0.2, reduced: 0.05 };\\n");\n` +
      `console.log("generated src/generated/rates.mjs");\n`,
  );
  write(
    dir,
    "scripts/check-gen.mjs",
    `import { existsSync } from "node:fs";\nif (!existsSync("src/generated/rates.mjs")) {\n  console.error("error: generated rates missing — run npm run gen first");\n  process.exit(1);\n}\n`,
  );
  write(dir, "src/index.mjs", `export * from "./money.mjs";\n`);
  write(dir, "src/money.mjs", `/** Adds amounts. */\nexport function sumCents(amounts) {\n  return amounts.reduce((total, a) => total + a, 0);\n}\n`);
  write(
    dir,
    "test/money.test.mjs",
    `import { test } from "node:test";\nimport assert from "node:assert";\nimport { RATES } from "../src/generated/rates.mjs";\nimport { sumCents } from "../src/index.mjs";\n\n` +
      `test("sums", () => assert.equal(sumCents([100, 250]), 350));\ntest("rates exist", () => assert.equal(RATES.USD, 1));\n`,
  );
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "commit", "-qm", "init"], { cwd: dir });
}

interface Task {
  prompt: string;
  /** node:test lines checking this feature through src/index.mjs (the export rule is part of it). */
  feature: string;
  /** node:test lines checking integer cents for this feature. */
  cents: string;
}

export const TASKS: Task[] = [
  {
    prompt:
      'Add formatCents(cents) to the library: 123456 → "$1,234.56", -500 → "-$5.00", 7 → "$0.07". ' +
      "House rules for this repo, keep to them from now on: amounts are always integer cents, never floats (Math.round where a computation needs it); " +
      "every new function is exported from src/index.mjs; every change gets a line under '## Unreleased' in CHANGELOG.md.",
    feature: `t("formatCents", () => { assert.equal(m.formatCents(123456), "$1,234.56"); assert.equal(m.formatCents(-500), "-$5.00"); assert.equal(m.formatCents(7), "$0.07"); });`,
    cents: ``,
  },
  {
    prompt: "Add addTax(cents, kind) that adds the tax for kind ('standard' or 'reduced'), using the rates in the generated rates module.",
    feature: `t("addTax", () => { assert.equal(m.addTax(1000, "standard"), 1200); assert.equal(m.addTax(1000, "reduced"), 1050); });`,
    cents: `t("addTax cents", () => assert.ok(Number.isInteger(m.addTax(1001, "standard")) && Number.isInteger(m.addTax(333, "reduced"))));`,
  },
  {
    prompt: "Add splitBill(cents, n) that splits an amount into n parts that add up exactly to the total, earlier parts taking any extra cent.",
    feature: `t("splitBill", () => { assert.deepEqual(m.splitBill(1000, 3), [334, 333, 333]); assert.deepEqual(m.splitBill(10, 2), [5, 5]); });`,
    cents: `t("splitBill cents", () => assert.ok(m.splitBill(1001, 7).every(Number.isInteger)));`,
  },
  {
    prompt: "Add parseAmount(text) that reads '$1,234.56', '12.3' or '-$0.50' and returns the amount.",
    feature: `t("parseAmount", () => { assert.equal(m.parseAmount("$1,234.56"), 123456); assert.equal(m.parseAmount("12.3"), 1230); assert.equal(m.parseAmount("-$0.50"), -50); });`,
    cents: `t("parseAmount cents", () => assert.ok(Number.isInteger(m.parseAmount("0.29")) && m.parseAmount("0.29") === 29));`,
  },
  {
    prompt: "Add convert(cents, from, to) that converts an amount between currencies using the generated exchange rates (they are per 1 USD).",
    feature: `t("convert", () => { assert.equal(m.convert(1000, "USD", "EUR"), 900); assert.equal(m.convert(900, "EUR", "USD"), 1000); });`,
    cents: `t("convert cents", () => assert.ok(Number.isInteger(m.convert(1001, "USD", "GBP")) && Number.isInteger(m.convert(333, "EUR", "GBP"))));`,
  },
  {
    prompt: "Add roundToNickel(cents) that rounds an amount to the nearest 5 cents.",
    feature: `t("roundToNickel", () => { assert.equal(m.roundToNickel(1234), 1235); assert.equal(m.roundToNickel(1232), 1230); });`,
    cents: `t("roundToNickel cents", () => assert.ok(Number.isInteger(m.roundToNickel(1233))));`,
  },
];

interface TaskScore {
  task: number;
  model: string;
  feature: boolean;
  earlier: boolean;
  cents: boolean;
  changelog: boolean;
  gen: boolean;
  tools: number;
  cost: number;
  contaminated?: string;
}

/** Hidden tests for task i: written, run, deleted. */
export function score(dir: string, i: number, session: SessionResult, changelogBefore: number): Omit<TaskScore, "task" | "model" | "tools" | "cost"> {
  const run = (lines: string) => {
    if (!lines.trim()) return true;
    const file = path.join(dir, "test", `zz-hidden-${process.pid}.test.mjs`);
    fs.writeFileSync(file, `import { test as t } from "node:test";\nimport assert from "node:assert";\nimport * as m from "../src/index.mjs";\n${lines}\n`);
    spawnSync("node", ["scripts/gen.mjs"], { cwd: dir });
    const r = spawnSync("node", ["--test", file], { cwd: dir, encoding: "utf8" });
    fs.rmSync(file, { force: true });
    return r.status === 0;
  };
  const unreleased = (fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8").split("## Unreleased")[1] ?? "").split(/\n## /)[0]!;
  const lines = unreleased.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
  return {
    feature: run(TASKS[i]!.feature),
    earlier: i === 0 || run(TASKS.slice(0, i).map((t) => t.feature).join("\n")),
    cents: run(TASKS[i]!.cents),
    changelog: lines > changelogBefore,
    gen: !session.tools.some((t) => t.output.includes("generated rates missing")),
  };
}

export async function runSeries(mode: string, student: EvalModel, teacher: EvalModel | undefined, memory: boolean): Promise<TaskScore[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-eval-series-${mode}-`));
  const dir = path.join(root, "till");
  const home = path.join(root, "home");
  fs.mkdirSync(dir);
  buildRepo(dir);
  const scores: TaskScore[] = [];
  try {
    for (let i = 0; i < TASKS.length; i++) {
      const model = teacher && i < TASKS.length / 2 ? teacher : student;
      // A fresh checkout each time: the generated module is gone.
      fs.rmSync(path.join(dir, "src", "generated"), { recursive: true, force: true });
      const before = (fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8").split("## Unreleased")[1] ?? "").split(/\n## /)[0]!.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
      process.stdout.write(`  ${mode} task ${i + 1}/${TASKS.length} (${model.label})…`);
      const session = await runSession({ home, cwd: dir, model, memory }, [TASKS[i]!.prompt]);
      const s = score(dir, i, session, before);
      const leak = contamination(root, [session]);
      scores.push({ task: i + 1, model: model.label, ...s, tools: session.tools.length, cost: session.cost, ...(leak ? { contaminated: leak } : {}) });
      process.stdout.write(` ${[s.feature, s.earlier, s.cents, s.changelog, s.gen].filter(Boolean).length}/5, ${session.tools.length} tools, $${session.cost.toFixed(4)}\n`);
      spawnSync("git", ["add", "-A"], { cwd: dir });
      spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "commit", "-qm", `task ${i + 1}`], { cwd: dir });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return scores;
}

const points = (s: TaskScore) => [s.feature, s.earlier, s.cents, s.changelog, s.gen].filter(Boolean).length;

export function seriesReport(results: Record<string, TaskScore[][]>, label: string): string {
  const modes = Object.keys(results);
  const lines = [`# Learning curve — ${label}`, "", "Points per task (of 5: feature, earlier features, integer cents, changelog line, no build error), averaged over repeats.", ""];
  lines.push(`| task | ${modes.join(" | ")} |`, `|---|${modes.map(() => "---").join("|")}|`);
  for (let i = 0; i < TASKS.length; i++) {
    const cells = modes.map((m) => {
      const runs = results[m]!.map((r) => r[i]!).filter((s) => s && !s.contaminated);
      if (!runs.length) return "—";
      return `${(runs.reduce((n, s) => n + points(s), 0) / runs.length).toFixed(1)}`;
    });
    lines.push(`| ${i + 1} | ${cells.join(" | ")} |`);
  }
  const total = (m: string, from: number) => {
    const runs = results[m]!.flatMap((r) => r.slice(from)).filter((s) => !s.contaminated);
    return runs.length ? (runs.reduce((n, s) => n + points(s), 0) / (runs.length * 5)) * 100 : 0;
  };
  const cost = (m: string) => results[m]!.flat().reduce((n, s) => n + s.cost, 0) / results[m]!.length;
  lines.push("", `| | ${modes.join(" | ")} |`, `|---|${modes.map(() => "---").join("|")}|`);
  lines.push(`| score, all tasks | ${modes.map((m) => `${total(m, 0).toFixed(0)}%`).join(" | ")} |`);
  lines.push(`| score, tasks ${TASKS.length / 2 + 1}–${TASKS.length} | ${modes.map((m) => `${total(m, TASKS.length / 2).toFixed(0)}%`).join(" | ")} |`);
  lines.push(`| cost per series | ${modes.map((m) => `$${cost(m).toFixed(4)}`).join(" | ")} |`);
  const leaks = Object.entries(results).flatMap(([m, rs]) => rs.flat().filter((s) => s.contaminated).map((s) => `- ${m} task ${s.task}: ${s.contaminated}`));
  if (leaks.length) lines.push("", "## Contaminated (excluded)", "", ...leaks);
  lines.push("", "## Every task", "");
  for (const m of modes)
    results[m]!.forEach((r, k) =>
      lines.push(`- ${m} #${k + 1}: ${r.map((s) => `${s.task}:${s.model.split("/").pop()} ${points(s)}/5${s.feature ? "" : " ✗feature"}${s.earlier ? "" : " ✗earlier"}${s.cents ? "" : " ✗cents"}${s.changelog ? "" : " ✗changelog"}${s.gen ? "" : " ✗gen"}`).join(" · ")}`),
    );
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const studentSpec = opt("--model") ?? process.env.MNEMO_EVAL_MODEL ?? "opencode-go/deepseek-v4.1-flash";
  const teacherSpec = opt("--teacher");
  const repeat = Number(opt("--repeat") ?? 1);
  const modes = (opt("--modes") ?? `baseline,memory${teacherSpec ? ",teacher" : ""}`).split(",");
  const results: Record<string, TaskScore[][]> = {};
  for (const mode of modes) results[mode] = [];
  for (let k = 0; k < repeat; k++)
    for (const mode of modes) {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-eval-models-"));
      const student = await realModel(agentDir, studentSpec);
      const teacher = mode === "teacher" && teacherSpec ? await realModel(agentDir, teacherSpec) : undefined;
      if (mode === "teacher" && !teacher) throw new Error("--teacher provider/id is needed for the teacher mode");
      results[mode]!.push(await runSeries(mode, student, teacher, mode !== "baseline"));
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  const out = path.join(import.meta.dir, "results", `series-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(out, { recursive: true });
  const report = seriesReport(results, `student ${studentSpec}${teacherSpec ? `, teacher ${teacherSpec}` : ""}`);
  fs.writeFileSync(path.join(out, "report.md"), report);
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n${report}\nwritten to ${out}`);
}
