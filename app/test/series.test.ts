/**
 * The series benchmark measures what it claims: a reference solution scores
 * every point on every task; an untouched repo, a float answer, a missing
 * export or a missing changelog line each lose theirs.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRepo, score, TASKS } from "../eval/series.ts";
import type { SessionResult } from "../eval/harness.ts";

const REFERENCE = [
  `export function formatCents(c) { const s = c < 0 ? "-" : ""; const a = Math.abs(c); return s + "$" + Math.floor(a / 100).toLocaleString("en-US") + "." + String(a % 100).padStart(2, "0"); }`,
  `import { TAX } from "./generated/rates.mjs";\nexport function addTax(c, k) { return c + Math.round(c * TAX[k]); }`,
  `export function splitBill(c, n) { const b = Math.floor(c / n); return Array.from({ length: n }, (_, i) => b + (i < c - b * n ? 1 : 0)); }`,
  `export function parseAmount(t) { const neg = t.trim().startsWith("-"); const v = Math.round(Number(t.replace(/[^0-9.]/g, "")) * 100); return neg ? -v : v; }`,
  `import { RATES } from "./generated/rates.mjs";\nexport function convert(c, f, t) { return Math.round((c / RATES[f]) * RATES[t]); }`,
  `export function roundToNickel(c) { return Math.round(c / 5) * 5; }`,
];

const session = (output = "") => ({ tools: [{ name: "bash", args: {}, ok: true, output }] }) as unknown as SessionResult;
const changelog = (dir: string, n: number) =>
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\n${Array.from({ length: n }, (_, i) => `- change ${i}`).join("\n")}\n\n## 0.1.0\n`);

test("a reference solution scores 5/5 on every task, cumulatively", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "series-ref-"));
  buildRepo(dir);
  for (let i = 0; i < TASKS.length; i++) {
    fs.writeFileSync(path.join(dir, "src", `f${i}.mjs`), REFERENCE[i]!);
    fs.appendFileSync(path.join(dir, "src", "index.mjs"), `export * from "./f${i}.mjs";\n`);
    changelog(dir, i + 1);
    expect([i, score(dir, i, session(), i)]).toEqual([i, { feature: true, earlier: true, cents: true, changelog: true, gen: true }]);
  }
});

test("each rule is scored on its own: no feature, a float, no export, no changelog line, the build error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "series-bad-"));
  buildRepo(dir);
  expect(score(dir, 1, session("error: generated rates missing — run npm run gen first"), 0)).toEqual({ feature: false, earlier: false, cents: false, changelog: false, gen: false });
  // Correct on round numbers, a float otherwise; exported.
  fs.writeFileSync(path.join(dir, "src", "tax.mjs"), `import { TAX } from "./generated/rates.mjs";\nexport function addTax(c, k) { return c * (1 + TAX[k]); }`);
  fs.appendFileSync(path.join(dir, "src", "index.mjs"), `export * from "./tax.mjs";\n`);
  expect(score(dir, 1, session(), 0)).toMatchObject({ feature: true, cents: false, changelog: false });
  // Not exported from the index: the feature does not count.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "series-noexport-"));
  buildRepo(other);
  fs.writeFileSync(path.join(other, "src", "tax.mjs"), REFERENCE[1]!);
  expect(score(other, 1, session(), 0).feature).toBe(false);
});
