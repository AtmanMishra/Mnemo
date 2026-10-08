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
import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { KernelClient, spawnKernel, type KernelChild } from "../kernel/kernel.ts";
import bridgeSource from "../../python/ipy_bridge.py" with { type: "text" };
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
    let current: ExtensionToolContext | undefined;

    const kernel = (cwd: string) =>
      (client ??= new KernelClient({
        interpreter: python,
        bridgePath: installBridge(host.home),
        spawn: (i, a) => spawnKernel(i, a, cwd) as unknown as KernelChild,
        cwd,
        dispatch: async (name, args) => {
          if (!current) throw new Error("no tool context");
          const outcome = await current.executeTool(name, args);
          if (outcome.isError) throw new Error(textOf(outcome.result) || `${name} failed`);
          return textOf(outcome.result);
        },
      }));

    pi.registerTool(
      defineTool({
        name: "ipy_run",
        label: "Python",
        description:
          "Run Python in a persistent kernel (state survives between calls). Use it to compute, transform data, or script many steps at once. " +
          "Inside the code, call tools as tools.read(path=...), tools.bash(command=...), tools.grep(pattern=...); " +
          "tools.parallel([(\"read\", {\"path\": \"a\"}), ...]) runs several at once. The value of the last expression is returned.",
        parameters: Type.Object({ code: Type.String({ description: "Python source to run" }) }),
        async execute(_id, params, _signal, _update, ctx) {
          current = ctx;
          try {
            const r = await kernel(ctx.cwd).run(params.code);
            const parts = [r.output?.trimEnd(), r.result && r.result !== "None" ? r.result : undefined].filter(Boolean);
            if (!r.ok) throw new Error([r.output?.trimEnd(), r.error].filter(Boolean).join("\n") || "the cell failed");
            return { content: [{ type: "text", text: parts.join("\n") || "(no output)" }], details: { result: r.result } };
          } finally {
            current = undefined;
          }
        },
      }),
    );

    pi.on("session_shutdown", async () => {
      client?.stop();
    });
  };
}
