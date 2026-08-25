import { test } from "node:test";
import assert from "node:assert/strict";
import { checkToolSource, extractImportSpecifiers, syntaxGate } from "../src/safety.ts";

const OK_SCHEMA_LINE = 'schema: { type: "object" },';

function fullTool(body: string): string {
  return `
${body}
export default {
  name: "t",
  ${OK_SCHEMA_LINE}
  async execute(params) { return "ok"; },
};
`;
}

test("rejects child_process and fs imports", () => {
  for (const spec of ["child_process", "node:child_process", "fs", "node:fs", "fs/promises", "node:fs/promises"]) {
    const report = checkToolSource(fullTool(`import x from ${JSON.stringify(spec)}; void x;`));
    assert.equal(report.ok, false, `expected rejection of ${spec}`);
    assert.ok(report.issues.some((i) => i.kind === "import" && i.message.includes(spec)));
  }
});

test("catches require() and dynamic import() too", () => {
  for (const src of [
    fullTool('const cp = require("child_process");'),
    fullTool('await import("node:fs").then(m => m.readFileSync);'),
  ]) {
    const report = checkToolSource(src);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((i) => i.kind === "import"));
  }
});

test("allowModules option permits specific blocked modules", () => {
  const report = checkToolSource(fullTool('import { readFileSync } from "node:fs";'), {
    allowModules: ["node:fs"],
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  // but only what was allowlisted:
  const denied = checkToolSource(fullTool('import { exec } from "node:child_process";'), {
    allowModules: ["node:fs"],
  });
  assert.equal(denied.ok, false);
});

test("relative imports are allowed", () => {
  const report = checkToolSource(fullTool('import { helper } from "./util.mjs";'));
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("syntax errors are caught before load", () => {
  assert.ok(syntaxGate("export default { name: 'x', execute: (() => {{{"));
  assert.equal(syntaxGate(fullTool("// fine")), null);
});

test("extractImportSpecifiers finds all forms", () => {
  const specs = extractImportSpecifiers(`
    import def, { a as b } from 'one';
    import * as ns from "two";
    import 'three';
    const m = await import('four');
    const r = require('five');
  `);
  assert.deepEqual(specs.sort(), ["five", "four", "one", "three", "two"]);
});
