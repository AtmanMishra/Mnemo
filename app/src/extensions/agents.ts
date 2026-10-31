/**
 * `spawn_subagent`: hand a self-contained task to a child agent.
 *
 * The child is a second pi session in this process — no second binary, no
 * pipe. It gets a brief the parent wrote (never the parent's transcript), a
 * model and limits (`resolveSpawn`: the user's settings, which the parent may
 * only tighten), and a copy of the host one level deeper: the same memory
 * journal (what it learns, the parent can recall) and the same approval
 * prompts (the user still answers for every edit and command). Its steps
 * stream into the parent's tool block while it works.
 */
import { Type, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Host } from "./host.ts";
import { RosterError, type Limits, type SubCaps } from "../runtime/roster.ts";
import { stepLine } from "./peers.ts";
import { piSettings, projectTrusted } from "../runtime/runtime.ts";
import { SUB_CONTEXT_MIN, THINKING_CHOICES, type Settings } from "../runtime/settings.ts";
import { loadManaged, nameAllowed } from "../policy/managed.ts";
import { loadHooks, subagentHooks } from "./hooks.ts";
import { subDirOf } from "../runtime/session-files.ts";

/** What a parent asked for one sub-agent, beside its brief. */
export interface SpawnAsk {
  model?: string;
  thinking?: string;
  maxTokens?: number;
  contextTokens?: number;
  maxTurns?: number;
  budget?: number;
}

export interface SpawnPlan {
  /** A copy of the chosen model with its output and context lowered to the limits: pi reads both from it. */
  model: Model<any>;
  thinking: string;
  caps: SubCaps;
  /** Each choice the parent did not get as asked, and why, for its tool result. */
  notes: string[];
}

const LEVELS = THINKING_CHOICES.filter((l) => l !== "inherit");
const name = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/**
 * The model and limits of one sub-agent. The user's settings are the ceiling: the parent may
 * lower any of them, and raise one only where the setting is "no limit". The model must exist,
 * have credentials, be in `subModels` when the parent picks it, and pass the managed allowlist.
 */
export function resolveSpawn(o: {
  ask: SpawnAsk;
  settings: Pick<Settings, "subModel" | "subModels" | "subThinking" | "subMaxTokens" | "subContext">;
  limits: Pick<Limits, "subMaxTurns" | "subSpend">;
  parent: Model<any>;
  parentThinking: string;
  find: (provider: string, id: string) => Model<any> | undefined;
  hasAuth: (provider: string) => boolean;
  managed?: readonly string[];
}): { ok: true; plan: SpawnPlan } | { ok: false; reason: string } {
  const { ask, settings: s, limits } = o;
  const notes: string[] = [];

  let model = o.parent;
  const spec = ask.model?.trim() || s.subModel;
  if (spec && spec !== name(o.parent)) {
    const whose = ask.model?.trim() ? "" : " (your user's subModel setting)";
    const slash = spec.indexOf("/");
    const found = slash > 0 ? o.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
    if (!found) return { ok: false, reason: `no model ${spec}${whose}; give provider/id, for example ${name(o.parent)}` };
    if (ask.model?.trim() && s.subModels) {
      const allowed = s.subModels.split(",").map((p) => p.trim()).filter(Boolean);
      if (!nameAllowed(allowed, spec)) return { ok: false, reason: `${spec} is not among the models your user lets you pick (/settings subModels: ${allowed.join(", ")})` };
    }
    if (!o.hasAuth(found.provider)) return { ok: false, reason: `${spec}${whose} has no credentials` };
    model = found;
  }
  if (!nameAllowed(o.managed, name(model))) return { ok: false, reason: `${name(model)} is not allowed by the managed policy` };

  // Thinking: the setting is the most a parent may ask for; "inherit" makes the parent's own level that ceiling.
  const ceiling = s.subThinking === "inherit" ? o.parentThinking : s.subThinking;
  const top = LEVELS.indexOf(ceiling as (typeof LEVELS)[number]);
  let thinking = ceiling;
  if (ask.thinking) {
    const want = LEVELS.indexOf(ask.thinking as (typeof LEVELS)[number]);
    if (want < 0) return { ok: false, reason: `thinking is one of ${LEVELS.join(", ")}` };
    if (top >= 0 && want > top) notes.push(`thinking capped at ${ceiling} (${s.subThinking === "inherit" ? "your own level" : "/settings subThinking"})`);
    else thinking = ask.thinking;
  }

  // A count the user set (above 0) is a ceiling; at 0 (no limit) the parent may pick any value.
  const cap = (asked: number | undefined, setting: number, label: string, show: (n: number) => string): number => {
    if (asked === undefined) return setting;
    if (!(asked > 0)) return setting;
    if (setting > 0 && asked > setting) {
      notes.push(`${label} capped at your user's ${show(setting)}`);
      return setting;
    }
    return asked;
  };
  const turns = cap(ask.maxTurns === undefined ? undefined : Math.floor(ask.maxTurns), limits.subMaxTurns, "maxTurns", (n) => `subMaxTurns of ${n}`);
  const spend = cap(ask.budget, limits.subSpend, "budget", (n) => `subSpend of $${n.toFixed(2)}`);

  // Output and context also stop at what the model itself has.
  const tokens = Math.min(cap(ask.maxTokens === undefined ? undefined : Math.floor(ask.maxTokens), s.subMaxTokens, "maxTokens", (n) => `subMaxTokens of ${n}`) || model.maxTokens, model.maxTokens);
  let context = Math.min(cap(ask.contextTokens === undefined ? undefined : Math.floor(ask.contextTokens), s.subContext, "contextTokens", (n) => `subContext of ${n}`) || model.contextWindow, model.contextWindow);
  if (context < SUB_CONTEXT_MIN && model.contextWindow >= SUB_CONTEXT_MIN) {
    notes.push(`contextTokens raised to the minimum of ${SUB_CONTEXT_MIN}`);
    context = SUB_CONTEXT_MIN;
  }

  return {
    ok: true,
    plan: { model: { ...model, maxTokens: tokens, contextWindow: context }, thinking, caps: { turns, spend, maxTokens: tokens, context }, notes },
  };
}

const READ_ONLY = ["read", "grep", "find", "ls", "code_search", "code_symbol", "code_refs", "code_map", "memory_search", "spawn_subagent", "list_agents", "message_agent"];

export function agentsExtension(host: Host, extensionsFor: (child: Host) => import("@earendil-works/pi-coding-agent").InlineExtension[]) {
  return (pi: ExtensionAPI): void => {
    if (host.depth >= host.roster.limits.maxDepth) return;
    // Read once per session, as the hooks extension does.
    const { hooks } = loadHooks(host);
    pi.registerTool(
      defineTool({
        name: "spawn_subagent",
        label: "Sub-agent",
        description:
          "Delegate a self-contained task to a sub-agent that works on its own and reports back. Write a complete brief: " +
          "the goal, the relevant files, constraints, and what to return. Use 'read-only' for research; 'full' lets it edit and run commands (the user still approves). " +
          "A sub-agent can start sub-agents of its own, to a limited depth, and can message the agents around it (list_agents). Start independent tasks in one step to run them side by side. " +
          "Model and limits default to the user's settings; you may lower them (a cheaper model or a smaller budget for a simple task), never raise them past the user's.",
        parameters: Type.Object({
          task: Type.String({ description: "The complete brief" }),
          name: Type.Optional(Type.String({ description: "A short name for it, e.g. 'auth researcher'" })),
          access: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("full")])),
          model: Type.Optional(Type.String({ description: "provider/id" })),
          thinking: Type.Optional(Type.Union(LEVELS.map((l) => Type.Literal(l)))),
          maxTokens: Type.Optional(Type.Number({ description: "Output tokens per model call" })),
          contextTokens: Type.Optional(Type.Number({ description: "Context it keeps before compacting" })),
          maxTurns: Type.Optional(Type.Number({ description: "Model calls before it stops and returns what it has" })),
          budget: Type.Optional(Type.Number({ description: "Dollars before it stops and returns what it has" })),
        }),
        async execute(_id, params, signal, onUpdate, ctx) {
          if (!ctx.model) throw new Error("no model is selected");
          const access = params.access === "full" ? "full" : "read-only";
          const resolved = resolveSpawn({
            ask: params,
            settings: host.settings.get(),
            limits: host.roster.limits,
            parent: ctx.model,
            parentThinking: pi.getThinkingLevel(),
            find: (provider, id) => host.modelRuntime.getModel(provider, id),
            hasAuth: (provider) => host.modelRuntime.hasConfiguredAuth(provider),
            managed: loadManaged(host.managedFile)?.models,
          });
          if (!resolved.ok) throw new Error(resolved.reason);
          const { plan } = resolved;
          const modelName = `${plan.model.provider}/${plan.model.id}`;
          const refused = await subagentHooks(
            hooks,
            "SubagentStart",
            { parent: host.node, depth: host.depth + 1, name: params.name ?? "", task: params.task, access, model: modelName, thinking: plan.thinking, caps: plan.caps, cwd: ctx.cwd },
            ctx.cwd,
            host.agentDir,
          );
          if (refused) throw new Error(`A hook refused this sub-agent: ${refused}`);
          // Every transcript of a tree goes in its root session's folder, flat, whatever the depth.
          const rootFile = host.depth === 0 ? ctx.sessionManager.getSessionFile() : undefined;
          const subDir = host.depth === 0 ? (rootFile ? subDirOf(rootFile) : undefined) : host.subDir;
          let node;
          try {
            node = host.roster.addSub(host.node, { label: params.name ?? "", task: params.task, access, model: modelName, thinking: plan.thinking, caps: plan.caps });
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
            subDir,
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
              settingsManager: piSettings(ctx.cwd, host.agentDir, projectTrusted(ctx.cwd, host.agentDir), host.settings),
              resourceLoaderOptions: { extensionFactories: extensionsFor(child) },
            });
            ({ session } = await createAgentSessionFromServices({
              services,
              sessionManager: subDir ? SessionManager.create(ctx.cwd, subDir, { parentSession: rootFile ?? undefined }) : SessionManager.inMemory(ctx.cwd),
              model: plan.model,
              thinkingLevel: plan.thinking as never,
              tools: access === "full" ? undefined : READ_ONLY,
            }));
            await session.bindExtensions({});
            const file = session.sessionManager.getSessionFile();
            if (subDir && file) host.roster.setTranscript(node.id, file);
            const steps: string[] = [];
            // A sub-agent that has made its turns or spent its dollars is stopped and returns what it has.
            let turns = 0;
            let stoppedBy: string | undefined;
            const stop = (why: string) => {
              if (stoppedBy) return;
              stoppedBy = why;
              void session?.abort();
            };
            const { turns: maxTurns, spend } = plan.caps;
            // The parent's number only when it is the one that holds; a pick above the user's was capped to theirs.
            const limits = host.roster.limits;
            const whose = (mine: number, theirs: number, setting: string) => (mine !== theirs ? "set by its parent" : `/settings ${setting}`);
            unsubscribe = session.subscribe((event) => {
              if (event.type === "turn_start") {
                if (maxTurns > 0 && ++turns > maxTurns) return stop(`${maxTurns} turns (${whose(maxTurns, limits.subMaxTurns, "subMaxTurns")})`);
                host.roster.turn(node.id);
              }
              if ((event.type === "turn_start" || event.type === "message_end") && spend > 0 && (host.roster.get(node.id)?.spent ?? 0) >= spend) stop(`$${spend.toFixed(2)} (${whose(spend, limits.subSpend, "subSpend")})`);
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
            if (!stoppedBy && (!last || last.stopReason === "error")) {
              answer = `the sub-agent's model call failed: ${last?.errorMessage?.trim() || "no reply from the model"}`;
              throw new Error(answer);
            }
            answer = session.getLastAssistantText()?.trim() || (stoppedBy ? "" : "(the sub-agent finished without an answer)");
            if (stoppedBy) answer = `${answer}${answer ? "\n\n" : ""}[stopped at its limit of ${stoppedBy}; ${answer ? "this is what it had" : "it had nothing to report"}]`;
            outcome = "done";
            const ran = `[ran on ${plan.model.provider}/${plan.model.id}, thinking ${session.thinkingLevel}${plan.notes.length ? `; ${plan.notes.join("; ")}` : ""}]`;
            return {
              content: [{ type: "text", text: `${answer}\n\n${ran}` }],
              details: { steps: steps.length, cost: session.getSessionStats().cost, node: node.id, model: `${plan.model.provider}/${plan.model.id}` },
            };
          } finally {
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
            // A tree that was stopped keeps "stopped"; finish ignores a node that already ended.
            host.roster.finish(node.id, signal?.aborted ? "stopped" : outcome, answer);
            session?.dispose();
            const ended = host.roster.get(node.id);
            await subagentHooks(
              hooks,
              "SubagentStop",
              { agent: node.id, parent: host.node, depth: host.depth + 1, name: node.label, status: ended?.status ?? outcome, answer: (answer ?? "").slice(0, 2000), model: modelName, turns: ended?.turns ?? 0, spent: ended?.spent ?? 0, transcript: ended?.transcript, cwd: ctx.cwd },
              ctx.cwd,
              host.agentDir,
            );
          }
        },
      }),
    );
  };
}
