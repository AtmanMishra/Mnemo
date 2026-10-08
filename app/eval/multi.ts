#!/usr/bin/env bun
/**
 * Two repositories with conflicting rules, worked in alternation.
 *
 * "till" (eval/series.ts): integer cents, CHANGELOG.md, `npm run docs`,
 * `npm run gen` before tests. "ledger": the opposite on every point — amounts
 * are decimal strings ("12.30"), never numbers; a line at the top of
 * HISTORY.md (there is no changelog); `npm run api` rewrites API.txt;
 * `npm run fixtures` before tests. One user across both: every reply ends
 * with a `Changed:` line. Each repository's rules are stated once, in its
 * first task; tasks then alternate till, ledger, till, ledger …
 *
 * This is where memory designs differ: a memory shared by every project has
 * to keep both rule sets apart (and within its size), a per-project memory
 * keeps them apart by construction. Applying one repository's rule in the
 * other is scored as a miss (a CHANGELOG.md appearing in ledger, a number
 * where a string belongs).
 *
 *   bun eval/multi.ts [--modes baseline,hermes,memory] [--repeat n] [--model provider/id]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { realModel, runSession, type EvalModel, type SessionResult } from "./harness.ts";
import { contamination } from "./experiment.ts";
import { buildRepo as buildTill, score as scoreTill, TASKS as TILL } from "./series.ts";

const write = (dir: string, file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
};

export function buildLedger(dir: string): void {
  write(dir, "package.json", JSON.stringify({ name: "ledger", version: "0.3.0", private: true, type: "module", scripts: { fixtures: "node scripts/fixtures.mjs", api: "node scripts/api.mjs", test: "node scripts/check-fixtures.mjs && node --test" } }, null, 2) + "\n");
  write(dir, "README.md", "# ledger\n\nBookkeeping helpers.\n");
  write(dir, "HISTORY.md", "# History\n\n- 0.3.0: addAmounts.\n");
  write(dir, ".gitignore", "test/fixtures/\nnode_modules/\n");
  write(dir, "scripts/fixtures.mjs", `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("test/fixtures", { recursive: true });\nwriteFileSync("test/fixtures/fees.json", JSON.stringify({ card: "2.50", wire: "0.75" }));\nconsole.log("fixtures ready");\n`);
  write(dir, "scripts/check-fixtures.mjs", `import { existsSync } from "node:fs";\nif (!existsSync("test/fixtures/fees.json")) {\n  console.error("error: fixtures missing — run npm run fixtures first");\n  process.exit(1);\n}\n`);
  write(dir, "scripts/api.mjs", `import { writeFileSync } from "node:fs";\nconst m = await import("../src/index.mjs");\nwriteFileSync("API.txt", Object.keys(m).sort().join("\\n") + "\\n");\nconsole.log("wrote API.txt");\n`);
  write(dir, "API.txt", "addAmounts\n");
  write(dir, "src/index.mjs", `export * from "./amounts.mjs";\n`);
  write(dir, "src/amounts.mjs", `/** Adds two decimal-string amounts. */\nexport function addAmounts(a, b) {\n  return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);\n}\n`);
  write(dir, "test/amounts.test.mjs", `import { test } from "node:test";\nimport assert from "node:assert";\nimport { readFileSync } from "node:fs";\nimport { addAmounts } from "../src/index.mjs";\n\nconst fees = JSON.parse(readFileSync(new URL("./fixtures/fees.json", import.meta.url), "utf8"));\ntest("adds", () => assert.equal(addAmounts("1.10", "2.20"), "3.30"));\ntest("fees", () => assert.equal(fees.card, "2.50"));\n`);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "commit", "-qm", "init"], { cwd: dir });
}

interface Task {
  prompt: string;
  fn: string;
  feature: string;
  /** Results are decimal strings with two places. */
  strings: string;
}

export const LEDGER: Task[] = [
  {
    prompt:
      'Add formatAmount(amount) to the library: "1234.5" → "$1,234.50", "-5" → "-$5.00". ' +
      "Rules for this repo, keep to them from now on: amounts are always decimal strings with two places (\"12.30\"), never numbers, in and out; " +
      "every change gets a line at the top of the list in HISTORY.md (this repo has no changelog); after changing what the library exports, run `npm run api` so API.txt stays current.",
    fn: "formatAmount",
    feature: `t("formatAmount", () => { assert.equal(m.formatAmount("1234.5"), "$1,234.50"); assert.equal(m.formatAmount("-5"), "-$5.00"); });`,
    strings: ``,
  },
  {
    prompt: "Add addFee(amount, kind) that adds the fee for kind ('card' or 'wire'): the fees are in test/fixtures/fees.json (card 2.50, wire 0.75), but put them in the source as constants.",
    fn: "addFee",
    feature: `t("addFee", () => { assert.equal(m.addFee("10.00", "card"), "12.50"); assert.equal(m.addFee("1.25", "wire"), "2.00"); });`,
    strings: `t("addFee strings", () => { const v = m.addFee("3.10", "card"); assert.equal(typeof v, "string"); assert.match(v, /^-?\\d+\\.\\d{2}$/); });`,
  },
  {
    prompt: "Add splitAmount(amount, n) that splits an amount into n parts that add up exactly to it, earlier parts taking any extra cent.",
    fn: "splitAmount",
    feature: `t("splitAmount", () => { assert.deepEqual(m.splitAmount("10.00", 3), ["3.34", "3.33", "3.33"]); });`,
    strings: `t("splitAmount strings", () => assert.ok(m.splitAmount("1.00", 3).every((x) => typeof x === "string" && /^\\d+\\.\\d{2}$/.test(x))));`,
  },
  {
    prompt: "Add percentOf(amount, percent) that returns the given percent of an amount, rounded to the cent.",
    fn: "percentOf",
    feature: `t("percentOf", () => { assert.equal(m.percentOf("200.00", 15), "30.00"); assert.equal(m.percentOf("10.01", 50), "5.01"); });`,
    strings: `t("percentOf strings", () => assert.equal(typeof m.percentOf("3.33", 10), "string"));`,
  },
];

interface Point {
  repo: "till" | "ledger";
  task: number;
  feature: boolean;
  earlier: boolean;
  /** till: integer cents; ledger: decimal strings. */
  types: boolean;
  /** till: a CHANGELOG line; ledger: a HISTORY line at the top, and no CHANGELOG.md. */
  history: boolean;
  /** till: no `generated rates missing`; ledger: no `fixtures missing`. */
  build: boolean;
  /** till: docs/API.md; ledger: API.txt. */
  docs: boolean;
  reply: boolean;
  cost: number;
  contaminated?: string;
  commands: string[];
}

const reply = (s: SessionResult) => /^\s*\**Changed:?\**:?/.test((s.answers.at(-1) ?? "").trim().split("\n").filter((l) => l.trim()).at(-1) ?? "");

export function scoreLedger(dir: string, i: number, session: SessionResult, historyBefore: string[]): Omit<Point, "repo" | "task" | "cost" | "commands"> {
  const run = (lines: string) => {
    if (!lines.trim()) return true;
    const file = path.join(dir, "test", `zz-hidden-${process.pid}.test.mjs`);
    fs.writeFileSync(file, `import { test as t } from "node:test";\nimport assert from "node:assert";\nimport * as m from "../src/index.mjs";\n${lines}\n`);
    spawnSync("node", ["scripts/fixtures.mjs"], { cwd: dir });
    const r = spawnSync("node", ["--test", file], { cwd: dir, encoding: "utf8" });
    fs.rmSync(file, { force: true });
    return r.status === 0;
  };
  const items = (fs.readFileSync(path.join(dir, "HISTORY.md"), "utf8").split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)));
  const newTop = items.length > historyBefore.length && !historyBefore.includes(items[0]!);
  let api = "";
  try {
    api = fs.readFileSync(path.join(dir, "API.txt"), "utf8");
  } catch {
    /* gone */
  }
  return {
    feature: run(LEDGER[i]!.feature),
    earlier: i === 0 || run(LEDGER.slice(0, i).map((t) => t.feature).join("\n")),
    types: run(LEDGER[i]!.strings),
    history: newTop && !fs.existsSync(path.join(dir, "CHANGELOG.md")),
    build: !session.tools.some((t) => /^error: fixtures missing/m.test(t.output)),
    docs: api.split("\n").includes(LEDGER[i]!.fn),
    reply: reply(session),
  };
}

const KEYS = ["feature", "earlier", "types", "history", "build", "docs", "reply"] as const;
const points = (p: Point) => KEYS.filter((k) => p[k]).length;

async function runMulti(mode: string, model: EvalModel): Promise<Point[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-eval-multi-${mode}-`));
  const home = path.join(root, "home");
  const till = path.join(root, "till");
  const ledger = path.join(root, "ledger");
  fs.mkdirSync(till);
  fs.mkdirSync(ledger);
  buildTill(till);
  buildLedger(ledger);
  const out: Point[] = [];
  const memory = mode === "memory";
  const hermes = mode === "hermes";
  const commit = (dir: string, msg: string) => {
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "commit", "-qm", msg], { cwd: dir });
  };
  try {
    for (let i = 0; i < LEDGER.length; i++) {
      for (const repo of ["till", "ledger"] as const) {
        const dir = repo === "till" ? till : ledger;
        fs.rmSync(path.join(dir, repo === "till" ? "src/generated" : "test/fixtures"), { recursive: true, force: true });
        const prompt = repo === "till" ? TILL[i]!.prompt : LEDGER[i]!.prompt;
        const changelogBefore = repo === "till" ? (fs.readFileSync(path.join(till, "CHANGELOG.md"), "utf8").split("## Unreleased")[1] ?? "").split(/\n## /)[0]!.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).length : 0;
        const historyBefore = repo === "ledger" ? fs.readFileSync(path.join(ledger, "HISTORY.md"), "utf8").split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)) : [];
        process.stdout.write(`  ${mode} ${repo} task ${i + 1}…`);
        const session = await runSession({ home, cwd: dir, model, memory, hermes }, [prompt]);
        let p: Omit<Point, "repo" | "task" | "cost" | "commands">;
        if (repo === "till") {
          const s = scoreTill(till, i, session, changelogBefore);
          p = { feature: s.feature, earlier: s.earlier, types: s.cents, history: s.changelog && !fs.existsSync(path.join(till, "HISTORY.md")), build: s.gen, docs: s.docs, reply: s.reply };
        } else p = scoreLedger(ledger, i, session, historyBefore);
        const leak = contamination(root, [session]);
        const point: Point = {
          repo,
          task: i + 1,
          ...p,
          cost: session.cost,
          commands: session.tools.filter((t) => t.name === "bash").map((t) => String(t.args.command ?? "").slice(0, 140)),
          ...(leak ? { contaminated: leak } : {}),
        };
        out.push(point);
        process.stdout.write(` ${points(point)}/7${KEYS.filter((k) => !point[k]).map((k) => ` ✗${k}`).join("")}, $${session.cost.toFixed(4)}\n`);
        commit(dir, `${repo} ${i + 1}`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return out;
}

function report(results: Record<string, Point[][]>, label: string): string {
  const modes = Object.keys(results);
  const lines = [`# Two repositories, conflicting rules — ${label}`, "", "Points per session (of 7), averaged over repeats; tasks alternate till / ledger.", ""];
  lines.push(`| session | ${modes.join(" | ")} |`, `|---|${modes.map(() => "---").join("|")}|`);
  const n = results[modes[0]!]![0]!.length;
  for (let j = 0; j < n; j++) {
    const first = results[modes[0]!]![0]![j]!;
    lines.push(`| ${first.repo} ${first.task} | ${modes.map((m) => { const ps = results[m]!.map((r) => r[j]!).filter((p) => p && !p.contaminated); return ps.length ? (ps.reduce((a, p) => a + points(p), 0) / ps.length).toFixed(1) : "—"; }).join(" | ")} |`);
  }
  const pct = (m: string, f: (p: Point) => boolean = () => true) => {
    const ps = results[m]!.flat().filter((p) => !p.contaminated && f(p));
    return ps.length ? `${((ps.reduce((a, p) => a + points(p), 0) / (ps.length * 7)) * 100).toFixed(0)}%` : "—";
  };
  lines.push("", `| | ${modes.join(" | ")} |`, `|---|${modes.map(() => "---").join("|")}|`);
  lines.push(`| all sessions | ${modes.map((m) => pct(m)).join(" | ")} |`);
  lines.push(`| after both rule sets were stated (task ≥ 2) | ${modes.map((m) => pct(m, (p) => p.task >= 2)).join(" | ")} |`);
  for (const k of KEYS) lines.push(`| ${k} kept | ${modes.map((m) => { const ps = results[m]!.flat().filter((p) => !p.contaminated && p.task >= 2); return `${ps.filter((p) => p[k]).length}/${ps.length}`; }).join(" | ")} |`);
  lines.push(`| cost per run | ${modes.map((m) => `$${(results[m]!.flat().reduce((a, p) => a + p.cost, 0) / results[m]!.length).toFixed(4)}`).join(" | ")} |`);
  const leaks = Object.entries(results).flatMap(([m, rs]) => rs.flat().filter((p) => p.contaminated).map((p) => `- ${m} ${p.repo} ${p.task}: ${p.contaminated}`));
  if (leaks.length) lines.push("", "## Contaminated (excluded)", "", ...leaks);
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const spec = opt("--model") ?? process.env.MNEMO_EVAL_MODEL ?? "opencode-go/deepseek-v4.1-flash";
  const modes = (opt("--modes") ?? "baseline,hermes,memory").split(",");
  const repeat = Number(opt("--repeat") ?? 1);
  const results: Record<string, Point[][]> = Object.fromEntries(modes.map((m) => [m, []]));
  for (let k = 0; k < repeat; k++)
    for (const mode of modes) {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-eval-models-"));
      results[mode]!.push(await runMulti(mode, await realModel(agentDir, spec)));
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  const out = path.join(import.meta.dir, "results", `multi-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(out, { recursive: true });
  const md = report(results, `student ${spec}`);
  fs.writeFileSync(path.join(out, "report.md"), md);
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n${md}\nwritten to ${out}`);
}

