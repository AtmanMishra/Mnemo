/**
 * AREA 9 — hooks extension (user-facing scoped hooks, Part A of the design).
 *
 * Registers the hook engine onto pi's events via attachHooks() and the
 * /hook command (list|test|add|disable|enable). The engine core lives in
 * src/hooks/ and is pi-agnostic; this file is the thin prod wiring:
 *
 *   PreToolUse  <- tool_call      (can block, rewrites args)
 *   PostToolUse <- tool_result    (can modify the result)
 *   UserPromptSubmit <- input     (can block / transform)
 *   TurnEnd / SessionStart / SessionShutdown <- lifecycle observations
 *
 * Every invocation is audited through the shared ~/.mnemo/logs tracer (9.4).
 * At SessionStart (and after /hook add) the effective hooks are indexed into
 * memory as Procedural nodes (9.6) — best-effort; a dead sidecar never
 * breaks the session.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { attachHooks, HookEngine } from "../src/hooks/engine.ts";
import { runHookCommand, tokenize, type HookCommandCtx } from "../src/hooks/commands.ts";
import { HookMemsrvClient, syncHooksToMemory } from "../src/hooks/memory.ts";

/** Prod home: the same ~/.mnemo the tracer and auth store use. */
export function hooksHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? "";
}

/** One memsrv client per process, shared by all sync calls. */
let memClient: HookMemsrvClient | null = null;

function hooksMemsrv(): HookMemsrvClient {
  return (memClient ??= new HookMemsrvClient());
}

export function hooksInlineFactory(pi: ExtensionAPI): void {
  const engine = new HookEngine({
    home: hooksHome(),
    onSessionStart: async (cwd) => {
      // best-effort, never breaks startup; a missing binary logs nothing
      await syncHooksToMemory(hooksMemsrv(), engine.registry(cwd).hooks());
    },
  });
  attachHooks(pi, engine);

  pi.on("session_shutdown", () => {
    try { hooksMemsrv().stop(); } catch { /* sidecar already gone */ }
  });

  pi.registerCommand("hook", {
    description: "Hooks: list|test|add|disable|enable (scoped pre/post-tool + lifecycle rules)",
    handler: async (args: string, ctx: any) => {
      const cctx: HookCommandCtx = {
        cwd: ctx?.cwd ?? process.cwd(),
        home: hooksHome(),
        env: process.env,
        ui: ctx?.ui ?? { notify: () => {} },
        engine,
      };
      const report = await runHookCommand(args, cctx);
      // a new hook becomes recallable memory immediately
      if (tokenize(args)[0] === "add") {
        await syncHooksToMemory(hooksMemsrv(), engine.registry(cctx.cwd).hooks());
      }
      // multi-line reports render fine through notify (TUI lines)
      ctx?.ui?.notify?.(report, "info");
    },
  });
}

export const hooksExt: InlineExtension = {
  name: "sea-hooks",
  factory: hooksInlineFactory as any,
};

export default hooksExt;