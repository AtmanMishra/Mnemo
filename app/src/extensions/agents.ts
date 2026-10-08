/**
 * `spawn_subagent`: hand a self-contained task to a child agent.
 *
 * The child is a second pi session in this process — no second binary, no
 * pipe. It gets a brief the parent wrote (never the parent's transcript), the
 * parent's model, and a copy of the host one level deeper: the same memory
 * journal (what it learns, the parent can recall) and the same approval
 * prompts (the user still answers for every edit and command). Its steps
 * stream into the parent's tool block while it works.
 */
import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Host } from "./host.ts";

const READ_ONLY = ["read", "grep", "find", "ls", "memory_search"];

/** One line per child step, for the parent's live view. */
function stepLine(name: string, args: Record<string, unknown>): string {
  const subject = String(args.command ?? args.path ?? args.pattern ?? args.query ?? "").split("\n")[0]!.slice(0, 80);
  return `→ ${name}${subject ? `(${subject})` : ""}`;
}

export function agentsExtension(host: Host, extensionsFor: (child: Host) => import("@earendil-works/pi-coding-agent").InlineExtension[]) {
  return (pi: ExtensionAPI): void => {
    if (host.depth >= host.maxDepth) return;
    pi.registerTool(
      defineTool({
        name: "spawn_subagent",
        label: "Sub-agent",
        description:
          "Delegate a self-contained task to a sub-agent that works on its own and reports back. Write a complete brief: " +
          "the goal, the relevant files, constraints, and what to return. Use 'read-only' for research; 'full' lets it edit and run commands (the user still approves).",
        parameters: Type.Object({
          task: Type.String({ description: "The complete brief" }),
          access: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("full")])),
        }),
        async execute(_id, params, signal, onUpdate, ctx) {
          if (!ctx.model) throw new Error("no model is selected");
          const child: Host = {
            ...host,
            depth: host.depth + 1,
            background: host.background,
            signals: host.signals,
            episode: undefined,
            parentEpisode: host.episode,
          };
          const services = await createAgentSessionServices({
            cwd: ctx.cwd,
            agentDir: host.agentDir,
            modelRuntime: host.modelRuntime,
            resourceLoaderOptions: { extensionFactories: extensionsFor(child) },
          });
          const { session } = await createAgentSessionFromServices({
            services,
            sessionManager: SessionManager.inMemory(ctx.cwd),
            model: ctx.model,
            tools: params.access === "full" ? undefined : READ_ONLY,
          });
          await session.bindExtensions({});
          const steps: string[] = [];
          const unsubscribe = session.subscribe((event) => {
            if (event.type === "tool_execution_start") {
              steps.push(stepLine(event.toolName, (event.args ?? {}) as Record<string, unknown>));
              onUpdate?.({ content: [{ type: "text", text: steps.slice(-8).join("\n") }], details: { steps: steps.length } });
            }
          });
          const onAbort = () => void session.abort();
          signal?.addEventListener("abort", onAbort);
          try {
            await session.prompt(params.task);
            const answer = session.getLastAssistantText()?.trim() || "(the sub-agent finished without an answer)";
            return {
              content: [{ type: "text", text: answer }],
              details: { steps: steps.length, cost: session.getSessionStats().cost },
            };
          } finally {
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
            session.dispose();
          }
        },
      }),
    );
  };
}
