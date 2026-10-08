/** The ledger repository is scored as the till one is: a reference solution gets every point; the other repo's rules lose them. */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { buildLedger, LEDGER, scoreLedger } from "../eval/multi.ts";
import type { SessionResult } from "../eval/harness.ts";

const REFERENCE = [
  `export function formatAmount(a) { const c = Math.round(Number(a) * 100); const s = c < 0 ? "-" : ""; const x = Math.abs(c); return s + "$" + Math.floor(x / 100).toLocaleString("en-US") + "." + String(x % 100).padStart(2, "0"); }`,
  `const FEES = { card: "2.50", wire: "0.75" };\nexport function addFee(a, k) { return ((Math.round(Number(a) * 100) + Math.round(Number(FEES[k]) * 100)) / 100).toFixed(2); }`,
  `export function splitAmount(a, n) { const c = Math.round(Number(a) * 100); const b = Math.floor(c / n); return Array.from({ length: n }, (_, i) => ((b + (i < c - b * n ? 1 : 0)) / 100).toFixed(2)); }`,
  `export function percentOf(a, p) { return (Math.round((Math.round(Number(a) * 100) * p) / 100) / 100).toFixed(2); }`,
];
const session = (output = "", answer = "Done.\nChanged: src/x.mjs") => ({ tools: [{ name: "bash", args: {}, ok: true, output }], answers: [answer] }) as unknown as SessionResult;
const history = (dir: string) => fs.readFileSync(path.join(dir, "HISTORY.md"), "utf8").split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l));

test("a reference solution scores every point on every ledger task", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ref-"));
  buildLedger(dir);
  for (let i = 0; i < LEDGER.length; i++) {
    const before = history(dir);
    fs.writeFileSync(path.join(dir, "src", `f${i}.mjs`), REFERENCE[i]!);
    fs.appendFileSync(path.join(dir, "src", "index.mjs"), `export * from "./f${i}.mjs";\n`);
    const h = fs.readFileSync(path.join(dir, "HISTORY.md"), "utf8").replace("# History\n\n", `# History\n\n- ${LEDGER[i]!.fn} added\n`);
    fs.writeFileSync(path.join(dir, "HISTORY.md"), h);
    spawnSync("node", ["scripts/api.mjs"], { cwd: dir });
    expect([i, scoreLedger(dir, i, session(), before)]).toEqual([i, { feature: true, earlier: true, types: true, history: true, build: true, docs: true, reply: true }]);
  }
});

test("till's rules applied in ledger lose their points: numbers for amounts, a CHANGELOG, the build error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-bad-"));
  buildLedger(dir);
  const before = history(dir);
  fs.writeFileSync(path.join(dir, "src", "fee.mjs"), `export function addFee(a, k) { return Number(a) + (k === "card" ? 2.5 : 0.75); }`);
  fs.appendFileSync(path.join(dir, "src", "index.mjs"), `export * from "./fee.mjs";\n`);
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "## Unreleased\n- addFee\n");
  const s = scoreLedger(dir, 1, session("npm test\nerror: fixtures missing — run npm run fixtures first", "Added addFee."), before);
  expect(s).toMatchObject({ types: false, history: false, build: false, docs: false, reply: false });
});
