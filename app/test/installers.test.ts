// The release installers (scripts/get.sh, scripts/get.ps1) run on machines with nothing
// installed, under whatever sh or PowerShell is there. These run them for real under
// dash (the strictest common sh) and, when one is on the machine, pwsh.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const scripts = path.join(import.meta.dir, "..", "scripts");
const dash = Bun.which("dash");
const pwsh = process.env.MNEMO_TEST_PWSH || Bun.which("pwsh");

/** A Mnemo home with everything Mnemo writes at its root, plus `extra`. */
function home(extra: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-inst-"));
  const h = path.join(root, ".mnemo");
  for (const d of ["bin", "agent", "memory", "logs", "kernel", "best-of", "skill-history"]) fs.mkdirSync(path.join(h, d), { recursive: true });
  const files: Record<string, string> = { "state.json": "{}", "grants.json": "{}", "permissions.json": "{}", ".env": "", ...extra };
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(h, f), body);
  return h;
}

describe.if(!!dash && process.platform !== "win32")("get.sh", () => {
  const run = (h: string, ...args: string[]) =>
    Bun.spawnSync([dash!, path.join(scripts, "get.sh"), ...args], {
      env: { PATH: process.env.PATH!, HOME: path.dirname(h), MNEMO_HOME: h, MNEMO_LINK_DIR: path.join(path.dirname(h), "links"), NO_COLOR: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

  test("--deep --yes deletes a home holding saved approvals, permission rules and skill history", () => {
    const h = home();
    const r = run(h, "--deep", "--yes");
    expect({ code: r.exitCode, err: r.stderr.toString() }).toEqual({ code: 0, err: "" });
    expect(fs.existsSync(h)).toBe(false);
  });

  test("--deep refuses a home with files Mnemo did not put there, and fails", () => {
    const h = home({ "thesis.docx": "mine" });
    const r = run(h, "--deep", "--yes");
    expect(r.exitCode).not.toBe(0);
    expect(fs.readFileSync(path.join(h, "thesis.docx"), "utf8")).toBe("mine");
  });
});

describe.if(!!pwsh)("get.ps1", () => {
  /** Calls one of the functions get.ps1 defines inside Install-Mnemo, without running the installer. */
  const call = (fn: string, invocation: string) => {
    const ps = `$ErrorActionPreference = "Stop"
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${path.join(scripts, "get.ps1")}', [ref]$null, [ref]$null)
$f = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq '${fn}' }, $true) | Select-Object -First 1
Invoke-Expression $f.Extent.Text
${invocation}`;
    const r = Bun.spawnSync([pwsh!, "-NoProfile", "-NonInteractive", "-Command", ps], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
  };

  test("Test-MnemoHome knows everything Mnemo writes at the root of its home", () => {
    expect(call("Test-MnemoHome", `Test-MnemoHome '${home()}'`).out).toBe("True");
    expect(call("Test-MnemoHome", `Test-MnemoHome '${home({ "thesis.docx": "mine" })}'`).out).toBe("False");
  });
});

test("the installers and `mnemo uninstall` agree on what a Mnemo home holds", async () => {
  const { HOME_ENTRIES } = await import("../src/runtime/uninstall.ts");
  const sh = fs.readFileSync(path.join(scripts, "get.sh"), "utf8").match(/^\s*(state\.json\*.*)\) found=1 ;;$/m)?.[1];
  const ps = fs.readFileSync(path.join(scripts, "get.ps1"), "utf8").match(/^\s*\$known = (.*)$/m)?.[1];
  const shList = sh?.split("|").map((s) => s.trim().replace(/\*$/, ""));
  const psList = ps?.split(",").map((s) => s.trim().replace(/"/g, ""));
  expect(shList?.sort()).toEqual([...HOME_ENTRIES].sort());
  expect(psList?.sort()).toEqual([...HOME_ENTRIES].sort());
});

test("test-install.sh: every check in the container can fail the run", () => {
  const text = fs.readFileSync(path.join(scripts, "test-install.sh"), "utf8");
  const inner = text.slice(text.indexOf("sh -c '") + "sh -c '".length, text.lastIndexOf("'"));
  // `cond && echo ✓` is exempt from `set -e`: a false cond printed nothing and the run went on green.
  const unguarded = inner.split("\n").filter((l) => /echo "✓/.test(l) && !/^\s*echo "✓/.test(l) && !/\|\| \{[^}]*exit 1; \}; echo "✓/.test(l));
  expect(unguarded).toEqual([]);
  if (dash) expect(Bun.spawnSync([dash, "-n", "-c", inner]).exitCode).toBe(0);
});
