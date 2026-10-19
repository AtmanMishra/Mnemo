/**
 * `ipy_run`: a persistent Python interpreter the agent drives.
 *
 * The namespace survives between calls (define a function in one cell, call it
 * in the next), and code inside a cell can call Mnemo's own tools as
 * `tools.read(path="x")` or `tools.parallel([...])` — one program instead of N
 * model round trips. Those calls go through `ctx.executeTool`, so they pass
 * the same approval gate as calls the model makes directly.
 *
 * The bridge script ships inside the binary and is written to
 * `$MNEMO_HOME/kernel/` on first use. It is an interpreter, not a sandbox.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KernelClient, spawnKernel, type KernelChild } from "../kernel/kernel.ts";
import bridgeSource from "../../python/ipy_bridge.py" with { type: "text" };
import { childEnv, configuredKeys, envNames } from "../runtime/env.ts";
import { callerSignals, denial, kernelGuard, rulesOf } from "./policy.ts";
import type { Host } from "./host.ts";

/** Write the bundled bridge where Python can run it; rewrite only when it changed. */
export function installBridge(home: string): string {
  const file = path.join(home, "kernel", "ipy_bridge.py");
  let current: string | undefined;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== bridgeSource) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bridgeSource);
  }
  return file;
}

function textOf(result: { content?: { type: string; text?: string }[] } | undefined): string {
  return (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

export function kernelExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const python = host.python();
    if (!python) return;
    let client: KernelClient | undefined;

    const kernel = (cwd: string) =>
      (client ??= new KernelClient({
        interpreter: python,
        bridgePath: installBridge(host.home),
        spawn: (i, a) => spawnKernel(i, a, cwd, childEnv(process.env, configuredKeys(host.agentDir), envNames(host.settings.get().passEnv))) as unknown as KernelChild,
        cwd,
      }));

    pi.registerTool(
      defineTool({
        name: "ipy_run",
        label: "Python",
        description:
          "Run Python in a persistent kernel (state survives between calls). Use it to compute, transform data, or script many steps at once. " +
          "Inside the code, call tools as tools.read(path=...), tools.bash(command=...), tools.grep(pattern=...); " +
          "tools.parallel([(\"read\", {\"path\": \"a\"}), ...]) runs several at once. The value of the last expression is returned.",
        parameters: Type.Object({
          code: Type.String({ description: "Python source to run" }),
          timeout: Type.Optional(Type.Number({ description: `Seconds before the cell is stopped (default ${host.settings.get().kernelTimeout}, at most ${host.settings.get().kernelMaxTimeout})` })),
        }),
        async execute(id, params, signal, _update, ctx) {
          // Ends when this cell does, and closes any question one of its calls is waiting on.
          const done = new AbortController();
          callerSignals.set(id, done.signal);
          try {
            const { kernelTimeout, kernelMaxTimeout } = host.settings.get();
            const seconds = Math.min(kernelMaxTimeout, Math.max(1, params.timeout ?? kernelTimeout));
            // Deny rules reach what the cell does itself: a command it starts is judged as `bash`,
            // a file it opens as `read` or `write`. Read once per cell, like the gate per call.
            const rules = rulesOf(host);
            const guard = {
              ...kernelGuard(rules),
              check: (tool: "bash" | "read" | "write", input: Record<string, unknown>) =>
                tool === "write" ? (denial(rules, ctx.cwd, "write", input) ?? denial(rules, ctx.cwd, "edit", input)) : denial(rules, ctx.cwd, tool, input),
            };
            const r = await kernel(ctx.cwd).run(params.code, {
              timeoutMs: seconds * 1000,
              signal,
              guard,
              // This cell's calls go through this call's context: one shared "current"
              // context let an overlapping call answer another cell's tools.
              dispatch: async (name, args, stopped) => {
                const outcome = await ctx.executeTool(name, args, stopped ? { signal: stopped } : {});
                if (outcome.isError) throw new Error(textOf(outcome.result) || `${name} failed`);
                return textOf(outcome.result);
              },
            });
            const parts = [r.output?.trimEnd(), r.result && r.result !== "None" ? r.result : undefined].filter(Boolean);
            if (!r.ok) throw new Error([r.output?.trimEnd(), r.error].filter(Boolean).join("\n") || "the cell failed");
            return { content: [{ type: "text", text: parts.join("\n") || "(no output)" }], details: { result: r.result } };
          } finally {
            done.abort();
            callerSignals.delete(id);
          }
        },
      }),
    );

    pi.on("session_shutdown", async () => {
      client?.stop();
    });
  };
}
