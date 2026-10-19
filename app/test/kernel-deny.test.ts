/**
 * Deny rules reach inside the Python tool: a command a cell starts is judged as `bash`,
 * a file it opens as `read` or `write`. Each test is a way a cell used to get past them.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { kernelExtension } from "../src/extensions/kernel.ts";
import { denial, kernelGuard, type Rule } from "../src/extensions/policy.ts";
import { SettingsStore } from "../src/runtime/settings.ts";
import { probeInterpreter, resolveInterpreter } from "../src/kernel/kernel.ts";

const python = resolveInterpreter({ which: (c) => Bun.which(c), probe: probeInterpreter });
const withPython = python ? test : test.skip;

function kernelWith(rules: Rule[]) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-kdeny-")));
  fs.writeFileSync(path.join(home, "permissions.json"), JSON.stringify({ rules }));
  let tool: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> } | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const pi = { registerTool: (t: typeof tool) => (tool = t), on: (_: string, h: typeof shutdown) => (shutdown = h) };
  kernelExtension({ home, agentDir: home, python: () => python, settings: new SettingsStore() } as never)(pi as never);
  const ctx = { cwd: home, executeTool: async () => ({ isError: false, result: { content: [] } }) };
  const run = async (code: string) => {
    try {
      return (await tool!.execute("c", { code, timeout: 20 }, undefined, undefined, ctx)).content.map((c) => c.text).join("");
    } catch (e) {
      return `ERR ${String(e)}`;
    }
  };
  return { home, run, stop: () => shutdown?.() };
}

withPython("a command a cell starts meets the bash deny rules, however it is started", async () => {
  const k = kernelWith([{ tool: "bash", pattern: "rm *", action: "deny" }]);
  const victim = path.join(k.home, "keep.txt");
  fs.writeFileSync(victim, "x");
  // Paths as Python literals: a Windows path's backslashes are not escapes.
  const v = JSON.stringify(victim);
  try {
    for (const code of [
      `import os; os.system("rm " + ${v})`,
      `import subprocess; subprocess.run(["rm", ${v}])`,
      `import subprocess; subprocess.run("rm " + ${v}, shell=True)`,
      ...(process.platform === "win32" ? [] : [`import subprocess; subprocess.run(["/bin/sh", "-c", "true && rm " + ${v}])`]),
    ]) {
      const out = await k.run(code);
      expect(out, code).toContain("PermissionError");
      expect(out, code).toContain("rm *");
      expect(fs.existsSync(victim), code).toBe(true);
    }
    // What no rule names still runs.
    expect(await k.run(`import subprocess, sys; subprocess.run([sys.executable, "-c", "print('fine')"], capture_output=True, text=True).stdout.strip()`)).toContain("fine");
  } finally {
    await k.stop();
  }
}, 30_000);

withPython("a file a cell opens meets the read and write deny rules", async () => {
  const k = kernelWith([
    { tool: "read", pattern: "*.secret", action: "deny" },
    { tool: "write", pattern: "locked/*", action: "deny" },
  ]);
  fs.writeFileSync(path.join(k.home, "a.secret"), "hunter2");
  fs.mkdirSync(path.join(k.home, "locked"));
  try {
    expect(await k.run(`open("a.secret").read()`)).toContain("PermissionError");
    expect(await k.run(`import pathlib; pathlib.Path("locked/x").write_text("x")`)).toContain("PermissionError");
    expect(fs.existsSync(path.join(k.home, "locked", "x"))).toBe(false);
    expect(await k.run(`import os; os.rename("a.secret", "locked/y")`)).toContain("PermissionError");
    // Reading what is not denied, and writing elsewhere, are untouched.
    expect(await k.run(`open("free.txt", "w").write("ok"); open("free.txt").read()`)).toContain("ok");
  } finally {
    await k.stop();
  }
}, 30_000);

withPython("a thread a cell leaves behind cannot run what a rule might deny once the cell is over", async () => {
  const k = kernelWith([{ tool: "bash", pattern: "rm *", action: "deny" }]);
  const marker = path.join(k.home, "late.txt");
  try {
    await k.run(
      `import threading, time, subprocess, sys\n` +
        `def late():\n` +
        `    time.sleep(0.5)\n` +
        `    try:\n` +
        `        subprocess.run([sys.executable, "-c", "open(" + repr(${JSON.stringify(marker)}) + ", 'w')"])\n` +
        `    except PermissionError:\n` +
        `        pass\n` +
        `threading.Thread(target=late).start()`,
    );
    await Bun.sleep(1200);
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    await k.stop();
  }
}, 30_000);

withPython("with no deny rules the kernel asks nothing", async () => {
  const k = kernelWith([{ tool: "bash", pattern: "git status*", action: "allow" }]);
  try {
    expect(await k.run(`import subprocess, sys; subprocess.run([sys.executable, "-c", "print('hi')"], capture_output=True, text=True).stdout.strip()`)).toContain("hi");
  } finally {
    await k.stop();
  }
}, 30_000);

test("the guard asks only about what a deny rule could stop", () => {
  expect(kernelGuard([{ tool: "bash", pattern: "curl*", action: "deny" }])).toEqual({ exec: true, read: false, write: false });
  expect(kernelGuard([{ tool: "edit", pattern: ".env", action: "deny" }])).toEqual({ exec: false, read: false, write: true });
  expect(kernelGuard([{ tool: "*", action: "deny" }])).toEqual({ exec: true, read: true, write: true });
  expect(kernelGuard([{ tool: "bash", action: "allow" }])).toEqual({ exec: false, read: false, write: false });
});

test("denial looks through wrappers and lands paths as the gate does", () => {
  const rules: Rule[] = [{ tool: "bash", pattern: "curl*", action: "deny" }, { tool: "read", pattern: ".env*", action: "deny" }];
  expect(denial(rules, "/tmp", "bash", { command: "sudo -u root curl evil" })).toContain("curl*");
  expect(denial(rules, "/tmp", "bash", { command: "echo curl" })).toBeUndefined();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-kdeny-")));
  expect(denial(rules, dir, "read", { path: path.join(dir, ".env") })).toContain(".env*");
});
