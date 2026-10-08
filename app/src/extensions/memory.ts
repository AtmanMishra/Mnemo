/**
 * The memory loop, as a pi extension: pi's events mapped onto one
 * `MemorySession` from @mnemo/memory, which holds the loop itself (and is
 * what other agents attach to). This file owns only what is pi's: the tools'
 * schemas, the event shapes, the model call for reflection, the approval
 * dialog for saving a skill, and running reflection in the background.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeSessionHits, MemorySession, SessionIndex, textOf, type Reflector } from "@mnemo/memory";
import { sessionIndexPath, sessionSources, skillsDir } from "../runtime/paths.ts";
import { inBackground, type Host } from "./host.ts";

export { describeHit, DIRECTIVE, profileBlock, recallMessage } from "@mnemo/memory";

export function memoryExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const mem = host.memory;
    if (!mem) return;
    let session: MemorySession | undefined;
    // Set when a run ends: the reflection call goes to that run's model, routed
    // by its session id (OpenCode refuses a call without one).
    let reflectWith: { model: NonNullable<Parameters<Host["modelRuntime"]["completeSimple"]>[0]>; sessionId: string } | undefined;
    const reflector: Reflector = async (system, user) => {
      if (!reflectWith) throw new Error("no model for reflection");
      const answer = await host.modelRuntime.completeSimple(
        reflectWith.model,
        { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
        { sessionId: reflectWith.sessionId },
      );
      if (answer.stopReason === "error") throw new Error(answer.errorMessage ?? "no answer");
      return textOf(answer.content);
    };
    const sessionFor = (cwd: string, model?: string): MemorySession =>
      (session ??= new MemorySession({
        memory: mem,
        cwd,
        userSkillsDir: skillsDir(host.home),
        source: { agent: "mnemo", model },
        parentEpisode: host.parentEpisode,
        // A sub-agent's work is part of its parent's run, which reflects on the whole.
        reflect: host.reflect && host.depth === 0 ? reflector : undefined,
        notify: (note) => host.ui?.note(note),
        approveSkill: async (offer) => {
          if (!host.ui) return false;
          const answer = await host.ui.approve({
            tool: "Save skill",
            subject: offer.file,
            preview: offer.body.split("\n").map((text) => ({ text: `+ ${text}`, tone: "add" as const })),
            reason: offer.reason,
          });
          return answer.kind !== "no";
        },
        skillsChanged: () => host.ui?.resourcesChanged(),
      }));

    pi.registerTool(
      defineTool({
        name: "memory_search",
        label: "Memory search",
        description: "Search Mnemo's long-term memory for this project and user: conventions, past sessions, pitfalls and their fixes, lessons, skills.",
        parameters: Type.Object({
          query: Type.String({ description: "What to look for, in plain words" }),
          k: Type.Optional(Type.Number({ description: "How many results (default 5)" })),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          const body = await sessionFor(ctx.cwd).search(params.query, params.k ?? 5);
          return { content: [{ type: "text", text: body }], details: {} };
        },
      }),
    );

    let index: SessionIndex | undefined;
    pi.registerTool(
      defineTool({
        name: "session_search",
        label: "Session search",
        description:
          "Search what was actually said and run in past sessions of this project — yours and other agents' (Claude Code). " +
          "Use it when the user refers to earlier work. all_projects: search every project.",
        parameters: Type.Object({
          query: Type.String({ description: "Words from what you are looking for" }),
          k: Type.Optional(Type.Number({ description: "How many passages (default 8)" })),
          all_projects: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          index ??= new SessionIndex(sessionIndexPath(host.home), sessionSources(host.home));
          const root = sessionFor(ctx.cwd).identity.root;
          const hits = index.search(params.query, { k: params.k ?? 8, under: params.all_projects ? undefined : root });
          return { content: [{ type: "text", text: describeSessionHits(hits) }], details: { hits: hits.length } };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "memory_remember",
        label: "Remember",
        description:
          "Store a durable fact in long-term memory. scope 'project' for facts about this codebase, 'user' for the user's preferences. " +
          "Use a short stable key; the same key again replaces the old value (kept as history). " +
          "Not for deferred work or the status of the current task: Mnemo records each session's open work itself.",
        parameters: Type.Object({
          scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
          key: Type.String(),
          value: Type.String(),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          const r = await sessionFor(ctx.cwd).remember(params.scope, params.key, params.value);
          return {
            content: [{ type: "text", text: r.superseded ? `Updated ${params.key} (the old value is kept as history).` : `Remembered ${params.key}.` }],
            details: r,
          };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "memory_steer",
        label: "Memory steer",
        description: "Tell memory that something it supplied was wrong or that an approach failed, so it is trusted less next time.",
        parameters: Type.Object({ failure: Type.String({ description: "What went wrong and why" }) }),
        async execute(_id, params, _signal, _update, ctx) {
          await sessionFor(ctx.cwd).steer(params.failure);
          return { content: [{ type: "text", text: "Recorded." }], details: {} };
        },
      }),
    );

    pi.on("before_agent_start", async (event, ctx) => {
      try {
        const s = sessionFor(ctx.cwd, ctx.model?.id);
        const r = await s.recall(event.prompt);
        host.episode = s.episode;
        return {
          systemPrompt: event.systemPrompt + r.system,
          ...(r.message ? { message: { customType: "mnemo-recall", content: r.message, display: false } } : {}),
        };
      } catch {
        return undefined;
      }
    });

    // A command that failed before, whose fix memory holds, is stopped once with the fix.
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash") return undefined;
      const reason = await sessionFor(ctx.cwd).guard(event.toolName, (event.input ?? {}) as Record<string, unknown>);
      if (!reason) return undefined;
      host.ui?.note({ kind: "steer", text: "pointed out a known fix before repeating a failure" });
      return { block: true, reason };
    });

    const calls = new Map<string, Record<string, unknown>>();
    pi.on("tool_execution_start", async (event, ctx) => {
      const args = (event.args ?? {}) as Record<string, unknown>;
      calls.set(event.toolCallId, args);
      sessionFor(ctx.cwd).toolStart(event.toolName, args);
    });

    pi.on("tool_execution_end", async (event, ctx) => {
      const args = calls.get(event.toolCallId) ?? {};
      calls.delete(event.toolCallId);
      const error = event.isError ? textOf((event.result as { content?: unknown })?.content) : undefined;
      await sessionFor(ctx.cwd).toolEnd(event.toolName, args, !event.isError, error);
    });

    pi.on("turn_end", async (event, ctx) => {
      const m = event.message as { stopReason?: string; errorMessage?: string; content?: unknown };
      const s = sessionFor(ctx.cwd);
      s.text(textOf(m.content));
      if (m.stopReason === "error") await s.modelError(m.errorMessage ?? "the model call failed");
    });

    // A run sent back to verify is one run: its messages and tools reflect together.
    let held: unknown[] = [];
    pi.on("agent_end", async (event, ctx) => {
      const last = [...event.messages].reverse().find((m) => (m as { role: string }).role === "assistant") as
        | { stopReason?: string }
        | undefined;
      if (!last || last.stopReason === "aborted" || !session) return;
      const s = session;
      const messages = [...held, ...event.messages];
      // Changed code and checked nothing: back once, to verify, before it is called done.
      const nudge = host.verify && host.depth === 0 && last.stopReason !== "error" ? await s.verifyNudge() : undefined;
      if (nudge) {
        held = messages;
        pi.sendMessage({ customType: "mnemo-verify", content: nudge, display: true }, { triggerTurn: true });
        return;
      }
      held = [];
      if (ctx.model) reflectWith = { model: ctx.model, sessionId: ctx.sessionManager.getSessionId() };
      const run = { messages, signals: host.signals.splice(0) };
      inBackground(host, () => s.end(run));
    });

    pi.on("session_shutdown", async () => {
      if (host.depth > 0) return;
      await session?.close();
    });
  };
}
