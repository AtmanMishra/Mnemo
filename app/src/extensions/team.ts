/**
 * A team's shared plan and record (runtime/team.ts): `task_update` for the plan, a LOG.md line
 * for each tool an agent ran, and, at the start of each turn, what the other agents in the run
 * did since this one last looked. A turn a message starts skips before_agent_start, so peers.ts
 * adds the same digest to the message's frame. Like a peer message, it is data, never in the
 * system prompt.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Host } from "./host.ts";
import { stepLine } from "./peers.ts";
import { boardOf, pruneRuns, renderTask, type TaskAction } from "../runtime/team.ts";

/** Tools whose calls the roster's own events already put in the log. */
const LOGGED_ELSEWHERE = new Set(["message_agent", "list_agents", "spawn_subagent", "task_update"]);
const ACTIONS: TaskAction[] = ["add", "claim", "done", "block", "decide", "ask", "note"];

export function teamExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const me = host.node;
    const board = boardOf(host.roster, host.home);
    const calls = new Map<string, string>();

    if (host.depth === 0)
      pi.on("session_start", async () => {
        pruneRuns(host.home, host.settings.get().keepSubTranscripts);
      });

    pi.on("tool_execution_start", async (e) => {
      if (!LOGGED_ELSEWHERE.has(e.toolName)) calls.set(e.toolCallId, stepLine(e.toolName, (e.args ?? {}) as Record<string, unknown>).replace(/^→ /, ""));
    });
    pi.on("tool_execution_end", async (e) => {
      const line = calls.get(e.toolCallId);
      calls.delete(e.toolCallId);
      if (line) board.log(me, `${line}${e.isError ? " — failed" : ""}`);
    });

    pi.on("before_agent_start", async () => {
      const digest = board.digest(me);
      return digest ? { message: { customType: "mnemo-team", content: digest, display: false } } : undefined;
    });

    pi.registerTool(
      defineTool({
        name: "task_update",
        label: "Plan",
        description:
          "Keep the plan every agent in your run reads (TASK.md): add a step, claim one before you work on it, mark it done or blocked with a one-line result, " +
          "record a decision or an open question, or note something in the run's log. Use it when several agents share a task; the result is the plan as it now stands.",
        parameters: Type.Object({
          action: Type.Union(ACTIONS.map((a) => Type.Literal(a))),
          step: Type.Optional(Type.Number({ description: "The step's number in TASK.md (claim, done, block)" })),
          text: Type.Optional(Type.String({ description: "The step, result, decision, question or note, in one line" })),
        }),
        async execute(_id, params) {
          const r = board.update(me, params.action as TaskAction, { step: params.step, text: params.text });
          if (!r.ok) throw new Error(r.reason);
          return { content: [{ type: "text", text: r.text }], details: { action: params.action, step: params.step } };
        },
      }),
    );

    if (host.depth === 0)
      pi.registerCommand("task", {
        description: "the plan and log the agents of this run share (TASK.md, LOG.md)",
        handler: async (_args, ctx) => {
          const run = host.roster.get(me)?.run;
          const task = run ? board.taskOf(run) : undefined;
          const dir = run ? board.dirOf(run) : undefined;
          if (!task || !dir) {
            ctx.ui.notify("No shared plan in this run: it starts once a second agent works in it, or an agent adds a step.", "info");
            return;
          }
          ctx.ui.notify(`${renderTask(task).trim()}\n\nFiles: ${dir}`, "info");
        },
      });
  };
}
