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
  SettingsManager,
  defineTool,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Host } from "./host.ts";
import { RosterError } from "../runtime/roster.ts";
import { stepLine } from "./peers.ts";
import { projectTrusted } from "../runtime/runtime.ts";

const READ_ONLY = ["read", "grep", "find", "ls", "code_search", "code_symbol", "code_refs", "code_map", "memory_search", "spawn_subagent", "list_agents", "message_agent"];

export function agentsExtension(host: Host, extensionsFor: (child: Host) => import("@earendil-works/pi-coding-agent").InlineExtension[]) {
  return (pi: ExtensionAPI): void => {
    if (host.depth >= host.roster.limits.maxDepth) return;
    pi.registerTool(
      defineTool({
        name: "spawn_subagent",
        label: "Sub-agent",
        description:
          "Delegate a self-contained task to a sub-agent that works on its own and reports back. Write a complete brief: " +
          "the goal, the relevant files, constraints, and what to return. Use 'read-only' for research; 'full' lets it edit and run commands (the user still approves). " +
          "A sub-agent can start sub-agents of its own, to a limited depth, and can message the agents around it (list_agents). Start independent tasks in one step to run them side by side.",
        parameters: Type.Object({
          task: Type.String({ description: "The complete brief" }),
          name: Type.Optional(Type.String({ description: "A short name for it, e.g. 'auth researcher'" })),
          access: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("full")])),
        }),
        async execute(_id, params, signal, onUpdate, ctx) {
          if (!ctx.model) throw new Error("no model is selected");
          const access = params.access === "full" ? "full" : "read-only";
          let node;
          try {
            node = host.roster.addSub(host.node, { label: params.name ?? "", task: params.task, access });
          } catch (e) {
            if (e instanceof RosterError) throw new Error(e.message);
            throw e;
          }
          const child: Host = {
            ...host,
            depth: host.depth + 1,
            node: node.id,
            access,
            background: host.background,
            signals: host.signals,
            episode: undefined,
            parentEpisode: host.episode,
          };
          // The mode is the user's, and they can change it while the child works:
          // a copy taken at spawn time kept a child in yolo after a switch to plan.
          Object.defineProperty(child, "mode", {
            get: () => host.mode,
            set: (mode: Host["mode"]) => {
              host.mode = mode;
            },
            enumerable: true,
          });
          let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
          let unsubscribe = () => {};
          const onAbort = () => void session?.abort();
          let outcome: "done" | "failed" = "failed";
          let answer: string | undefined;
          try {
            const services = await createAgentSessionServices({
              cwd: ctx.cwd,
              agentDir: host.agentDir,
              modelRuntime: host.modelRuntime,
              settingsManager: SettingsManager.create(ctx.cwd, host.agentDir, { projectTrusted: projectTrusted(ctx.cwd, host.agentDir) }),
              resourceLoaderOptions: { extensionFactories: extensionsFor(child) },
            });
            ({ session } = await createAgentSessionFromServices({
              services,
              sessionManager: SessionManager.inMemory(ctx.cwd),
              model: ctx.model,
              tools: access === "full" ? undefined : READ_ONLY,
            }));
            await session.bindExtensions({});
            const steps: string[] = [];
            unsubscribe = session.subscribe((event) => {
              if (event.type === "tool_execution_start") {
                steps.push(stepLine(event.toolName, (event.args ?? {}) as Record<string, unknown>));
                onUpdate?.({ content: [{ type: "text", text: steps.slice(-8).join("\n") }], details: { steps: steps.length } });
              }
            });
            signal?.addEventListener("abort", onAbort);
            if (signal?.aborted) onAbort();
            await session.prompt(params.task);
            // A failed model call does not throw out of prompt(): it is the last reply, with an error and no text.
            // Say why, so the parent (and the user) see the cause instead of an empty answer.
            const last = session.messages.filter((m) => m.role === "assistant").at(-1) as { stopReason?: string; errorMessage?: string } | undefined;
            if (!last || last.stopReason === "error") {
              answer = `the sub-agent's model call failed: ${last?.errorMessage?.trim() || "no reply from the model"}`;
              throw new Error(answer);
            }
            answer = session.getLastAssistantText()?.trim() || "(the sub-agent finished without an answer)";
            outcome = "done";
            return {
              content: [{ type: "text", text: answer }],
              details: { steps: steps.length, cost: session.getSessionStats().cost, node: node.id },
            };
          } finally {
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
            // A tree that was stopped keeps "stopped"; finish ignores a node that already ended.
            host.roster.finish(node.id, signal?.aborted ? "stopped" : outcome, answer);
            session?.dispose();
          }
        },
      }),
    );
  };
}
