// A compiled binary cannot follow pi-ai's variable `import()`s, so subscription
// login failed with "Cannot find module './anthropic.js'" until src/runtime/bun-setup.ts
// registered the bundled flows. Only a real `bun build --compile` shows the bug, so
// this builds one: with the setup the login flow loads, without it the old error returns.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const app = path.join(import.meta.dir, "..");
const probe = `
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
const oauth = (anthropicProvider() as any).auth.oauth;
try { await oauth.toAuth({ access: "x", refresh: "y", expires: Date.now() + 1e9 }); console.log("loaded"); }
catch (e) { console.log(/Cannot find module/.test((e as Error).message) ? "missing" : "loaded"); }
`;

async function run(withSetup: boolean): Promise<string> {
  // Inside app/ so the packages resolve; removed afterwards.
  const src = path.join(app, `.probe-${process.pid}-${withSetup ? "with" : "without"}.ts`);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-probe-")), "probe");
  fs.writeFileSync(src, (withSetup ? `import "./src/runtime/bun-setup.ts";\n` : "") + probe);
  try {
    const built = await Bun.build({ entrypoints: [src], compile: { outfile: out } });
    if (!built.success) throw new Error(built.logs.join("\n"));
    const bin = process.platform === "win32" && !fs.existsSync(out) ? `${out}.exe` : out;
    const proc = Bun.spawnSync([bin], { cwd: os.tmpdir() });
    return proc.stdout.toString().trim();
  } finally {
    fs.rmSync(src, { force: true });
  }
}

describe("compiled binary", () => {
  test("subscription login flows load once bun-setup has run", async () => {
    expect(await run(true)).toBe("loaded");
  }, 120_000);

  test("without it they do not (the bug this guards)", async () => {
    expect(await run(false)).toBe("missing");
  }, 120_000);

  test("the entry point imports bun-setup before anything else", () => {
    const entry = fs.readFileSync(path.join(app, "bin", "mnemo.ts"), "utf8");
    const first = entry.match(/^import .*$/m)?.[0];
    expect(first).toBe('import "../src/runtime/bun-setup.ts";');
  });
});
