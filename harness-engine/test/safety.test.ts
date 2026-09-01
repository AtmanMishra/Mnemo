import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  // String-level gate (no rootDir): relative imports cannot be resolved yet,
  // so they are DEFERRED to the load-time gate (bundle.test.ts proves that
  // side: helpers are scanned, escapes rejected).
  const report = checkToolSource(fullTool('import { helper } from "./util.mjs";'));
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("absolute imports are rejected", () => {
  for (const spec of ["/etc/passwd.js", "/usr/local/lib/evil.mjs"]) {
    const report = checkToolSource(fullTool(`import x from ${JSON.stringify(spec)}; void x;`));
    assert.equal(report.ok, false, `expected rejection of ${spec}`);
    assert.ok(report.issues.some((i) => i.kind === "import" && i.message.includes("absolute")));
  }
});

test("backtick template specifiers are caught (56b733fa)", () => {
  const report = checkToolSource(fullTool("const m = await import(`node:child_process`); void m;"));
  assert.equal(report.ok, false, JSON.stringify(report.issues));
  assert.ok(report.issues.some((i) => i.kind === "import" && i.message.includes("child_process")));
});

test("non-literal (computed) specifiers are rejected (f685ee0a/a0dfa43b)", () => {
  for (const src of [
    fullTool("const s = [\"child\", \"_process\"].join(\"\"); const m = await import(s); void m;"),
    fullTool("const m = require(modName); void m;"),
    fullTool("const m = await import(`node:${dyn()}`); void m;"),
  ]) {
    const report = checkToolSource(src);
    assert.equal(report.ok, false, JSON.stringify(report.issues));
    assert.ok(
      report.issues.some((i) => i.kind === "import" && i.message.includes("non-literal")),
      JSON.stringify(report.issues),
    );
  }
});

test("net-class and host-info modules are blocked by default", () => {
  for (const spec of ["http", "node:http", "https", "net", "node:net", "tls", "dns", "os", "node:os", "node:process", "process"]) {
    const report = checkToolSource(fullTool(`import x from ${JSON.stringify(spec)}; void x;`));
    assert.equal(report.ok, false, `expected rejection of ${spec}`);
  }
  // ...but the engine API can still allowlist a specific one.
  const ok = checkToolSource(fullTool('import net from "node:net"; void net;'), {
    allowModules: ["node:net"],
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
});

test("process / globalThis.process access is blocked, import or not", () => {
  for (const body of [
    "return process.env.HOME;",
    "return process.cwd();",
    "return globalThis.process.version;",
    "const p = process; return p.arch;", // direct reference without dotted access on the same line
  ]) {
    const report = checkToolSource(fullTool(body));
    assert.equal(report.ok, false, `expected rejection of: ${body}`);
    assert.ok(report.issues.some((i) => i.message.includes("process")), JSON.stringify(report.issues));
  }
});

test("relative imports are resolved, confined, and depth-capped when rootDir is set (747c8c3b)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "safety-rel-"));
  try {
    const write = (rel: string, src: string) => {
      const f = path.join(tmp, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, src, "utf8");
      return f;
    };
    const toolSrc = (imp: string) =>
      `import { x } from ${JSON.stringify(imp)};\n` +
      `export default { name: "t", schema: { type: "object" }, async execute() { return String(x); } };\n`;

    // escape: helper outside the bundle root
    write("../outside.mjs", "export const x = 1;\n"); // lives next to tmp, i.e. outside
    const esc = checkToolSource(toolSrc("../../outside.mjs"), {
      rootDir: path.join(tmp, "bundle"),
      baseDir: path.join(tmp, "bundle", "tools"),
    });
    assert.equal(esc.ok, false, JSON.stringify(esc.issues));
    assert.ok(esc.issues.some((i) => i.message.includes("outside the bundle directory")));

    // clean chain inside the bundle: a -> b -> c (depth 2) is fine
    write("bundle/tools/a.mjs", toolSrc("./b.mjs"));
    write("bundle/tools/b.mjs", toolSrc("./c.mjs"));
    write("bundle/tools/c.mjs", "export const x = 42;\n");
    const clean = checkToolSource(readFileSync(path.join(tmp, "bundle/tools/a.mjs"), "utf8"), {
      rootDir: path.join(tmp, "bundle"),
      baseDir: path.join(tmp, "bundle/tools"),
    });
    assert.equal(clean.ok, true, JSON.stringify(clean.issues));

    // deep chain: a -> b -> c -> d -> e hits the depth cap before e
    write("deep/tools/a.mjs", toolSrc("./b.mjs"));
    write("deep/tools/b.mjs", toolSrc("./c.mjs"));
    write("deep/tools/c.mjs", toolSrc("./d.mjs"));
    write("deep/tools/d.mjs", toolSrc("./e.mjs"));
    write("deep/tools/e.mjs", "export const x = 1;\n");
    const deep = checkToolSource(readFileSync(path.join(tmp, "deep/tools/a.mjs"), "utf8"), {
      rootDir: path.join(tmp, "deep"),
      baseDir: path.join(tmp, "deep/tools"),
    });
    assert.equal(deep.ok, false, JSON.stringify(deep.issues));
    assert.ok(deep.issues.some((i) => i.message.includes("depth cap")));

    // blocked import hidden TWO files down the chain is still caught
    write("sneak/tools/a.mjs", toolSrc("./b.mjs"));
    write("sneak/tools/b.mjs", toolSrc("./c.mjs"));
    write("sneak/tools/c.mjs", 'import { execSync } from "node:child_process"; export const x = 1;\n');
    const sneak = checkToolSource(readFileSync(path.join(tmp, "sneak/tools/a.mjs"), "utf8"), {
      rootDir: path.join(tmp, "sneak"),
      baseDir: path.join(tmp, "sneak/tools"),
    });
    assert.equal(sneak.ok, false, JSON.stringify(sneak.issues));
    assert.ok(sneak.issues.some((i) => i.message.includes("child_process")));

    // missing helper file: unverifiable => rejected
    write("missing/tools/a.mjs", toolSrc("./nope.mjs"));
    const miss = checkToolSource(readFileSync(path.join(tmp, "missing/tools/a.mjs"), "utf8"), {
      rootDir: path.join(tmp, "missing"),
      baseDir: path.join(tmp, "missing/tools"),
    });
    assert.equal(miss.ok, false, JSON.stringify(miss.issues));
    assert.ok(miss.issues.some((i) => i.message.includes("missing or unreadable")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
    const bt = await import(\`six\`); // backtick literal
  `);
  assert.deepEqual(specs.sort(), ["five", "four", "one", "six", "three", "two"]);
});
