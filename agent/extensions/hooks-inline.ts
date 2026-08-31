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
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { attachHooks, HookEngine } from "../src/hooks/engine.ts";
import { runHookCommand, type HookCommandCtx } from "../src/hooks/commands.ts";

/** Prod home: the same ~/.mnemo the tracer and auth store use. */
export function hooksHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? "";
}

export function hooksInlineFactory(pi: ExtensionAPI): void {
  const engine = new HookEngine({ home: hooksHome() });
  attachHooks(pi, engine);

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