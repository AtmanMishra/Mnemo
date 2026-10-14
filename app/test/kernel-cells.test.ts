/**
 * The Python tool against what a security review found: cells that overlap,
 * a kernel that fills its stderr, processes a cell leaves behind, a tool call
 * still waiting when its cell is stopped, and a memory cap that is not a number.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { kernelExtension } from "../src/extensions/kernel.ts";
import { callerSignals, policyExtension } from "../src/extensions/policy.ts";
import { KernelClient, probeInterpreter, resolveInterpreter, spawnKernel, type KernelChild } from "../src/kernel/kernel.ts";

const python = resolveInterpreter({ which: (c) => Bun.which(c), probe: probeInterpreter });
const withPython = python ? test : test.skip;
const BRIDGE = path.join(import.meta.dir, "..", "python", "ipy_bridge.py");

function ipyTool() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-kern-"));
  let tool: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> } | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const pi = { registerTool: (t: typeof tool) => (tool = t), on: (_: string, h: typeof shutdown) => (shutdown = h) };
  kernelExtension({ home, agentDir: home, python: () => python } as never)(pi as never);
  const ctx = (label: string, executeTool?: (name: string, args: unknown, o?: { signal?: AbortSignal }) => Promise<unknown>) => ({
    cwd: home,
    executeTool: executeTool ?? (async (name: string) => ({ isError: false, result: { content: [{ type: "text", text: `${label} ran ${name}` }] } })),
  });
  return { tool: tool!, ctx, stop: () => shutdown?.() };
}

const text = async (p: Promise<{ content: { text: string }[] }>) => {
  try {
    return (await p).content.map((c) => c.text).join("");
  } catch (e) {
    return `ERR ${String(e)}`;
  }
};

withPython("a cell's tool calls go to that cell's caller, even when cells overlap", async () => {
  const k = ipyTool();
  try {
    const a = k.tool.execute("a", { code: "import time; time.sleep(0.5); 'A done'" }, undefined, undefined, k.ctx("ctxA"));
    const b = k.tool.execute("b", { code: "tools.read(path='x')" }, undefined, undefined, k.ctx("ctxB"));
    expect(await text(a)).toContain("A done");
    expect(await text(b)).toContain("ctxB ran read");
  } finally {
    await k.stop();
  }
}, 20_000);

withPython("a kernel that writes a lot to stderr does not hang", async () => {
  const k = ipyTool();
  try {
    const t0 = Date.now();
    const out = await text(k.tool.execute("c", { code: "import os; os.system('head -c 300000 /dev/zero >&2'); 'ok'", timeout: 10 }, undefined, undefined, k.ctx("C")));
    expect(out).toContain("ok");
    expect(Date.now() - t0).toBeLessThan(5000);
  } finally {
    await k.stop();
  }
}, 20_000);

withPython("a stopped cell takes the processes it started with it", async () => {
  if (process.platform === "win32") return;
  const k = ipyTool();
  const tag = `${4000 + (process.pid % 1000)}.5`;
  try {
    await text(k.tool.execute("d", { code: `import subprocess, time; subprocess.Popen(['sleep', '${tag}']); time.sleep(30)`, timeout: 1 }, undefined, undefined, k.ctx("D")));
    await Bun.sleep(300);
    const left = Bun.spawnSync(["pgrep", "-f", `sleep ${tag}`]).stdout.toString().trim();
    if (left) Bun.spawnSync(["pkill", "-f", `sleep ${tag}`]);
    expect(left).toBe("");
  } finally {
    await k.stop();
  }
}, 20_000);

withPython("a tool call still waiting when its cell stops is cancelled", async () => {
  const k = ipyTool();
  let nested: AbortSignal | undefined;
  let registered: AbortSignal | undefined;
  try {
    const hang = (_name: string, _args: unknown, o?: { signal?: AbortSignal }) => {
      nested = o?.signal;
      registered = callerSignals.get("e");
      return new Promise<never>(() => {});
    };
    await text(k.tool.execute("e", { code: "tools.bash(command='x')", timeout: 1 }, undefined, undefined, k.ctx("E", hang)));
    expect(nested?.aborted).toBe(true);
    expect(registered?.aborted).toBe(true);
    expect(callerSignals.has("e")).toBe(false);
  } finally {
    await k.stop();
  }
}, 20_000);

test("an approval asked for inside a cell closes when the cell stops", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-kern-"));
  let seen: AbortSignal | undefined;
  const host = {
    home,
    mode: "default",
    signals: [],
    ui: {
      approve: (_r: unknown, signal?: AbortSignal) => {
        seen = signal;
        return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ kind: "no" })));
      },
    },
  };
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  policyExtension(host as never)({ on: (_: string, h: typeof handler) => (handler = h) } as never);
  const cell = new AbortController();
  callerSignals.set("cell-1", cell.signal);
  try {
    const verdict = handler!({ toolName: "bash", parentToolCallId: "cell-1", input: { command: "make" } }, { cwd: home, signal: new AbortController().signal });
    await Bun.sleep(20);
    cell.abort();
    expect(await verdict).toMatchObject({ block: true });
    expect(seen?.aborted).toBe(true);
  } finally {
    callerSignals.delete("cell-1");
  }
});

withPython("a memory cap that is not a whole number keeps the default cap", async () => {
  if (process.platform !== "linux") return;
  const client = new KernelClient({
    interpreter: python!,
    bridgePath: BRIDGE,
    spawn: (bin, args) => spawnKernel(bin, args, undefined, { ...process.env, MNEMO_KERNEL_MEMORY_MB: "8g" }) as unknown as KernelChild,
    timeoutMs: 10_000,
  });
  try {
    const r = await client.run("import resource\nresource.getrlimit(resource.RLIMIT_AS)[0]");
    expect(r.result).toBe(String(8192 * 1024 * 1024));
  } finally {
    client.stop();
  }
}, 20_000);
