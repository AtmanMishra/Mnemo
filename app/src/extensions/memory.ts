/**
 * The memory loop, as a pi extension: pi's events mapped onto one
 * `MemorySession` from @mnemo/memory, which holds the loop itself (and is
 * what other agents attach to). This file owns only what is pi's: the tools'
 * schemas, the event shapes, the model call for reflection, the approval
 * dialogs for saving a skill or a team run's lesson, and running reflection in the background.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anchorKey, anchorTag, applyTidy, describeSessionHits, MemorySession, planTidy, projectIdentity, redact, SessionIndex, textOf, type AnchorCheck, type AnchorState, type MemoryService, type Reflector, type TidyItem } from "@mnemo/memory";
import { sessionIndexPath, sessionSources, skillsDir } from "../runtime/paths.ts";
import { boardOf } from "../runtime/team.ts";
import { inBackground, type Host } from "./host.ts";

export { describeHit, DIRECTIVE, profileBlock, recallMessage } from "@mnemo/memory";

const TIDY_EVERY = 24 * 60 * 60 * 1000;

/**
 * `mnemo memory tidy --apply`, by itself: at most once a day per project. Retired items stay in
 * the journal as history and are never recalled again; nothing is deleted. Undefined when it
 * was not due; otherwise what it retired (often nothing).
 */
export async function tidyWhenDue(mem: MemoryService, home: string, cwd: string, now = Date.now()): Promise<TidyItem[] | undefined> {
  const file = path.join(home, "memory", "tidied.json");
  let last: Record<string, number> = {};
  try {
    last = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // never tidied
  }
  const identity = projectIdentity(cwd);
  if (now - (last[identity.id] ?? 0) < TIDY_EVERY) return undefined;
  const plan = await planTidy(mem, identity.id, identity.root);
  if (plan.length) await applyTidy(mem, identity.id, plan);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ ...last, [identity.id]: now }, null, 2)}\n`, { mode: 0o600 });
  return plan;
}

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
    // Is the code each pinned fact is about as it was? Asked of the code index, which is brought up to date first.
    const anchorsIn = (cwd: string): AnchorCheck => async (anchors) => {
      const ix = await host.codeIndex?.(cwd);
      if (!ix || typeof ix === "string") return new Map();
      return new Map(
        anchors.map((a) => {
          const d = ix.lookup(`${a.path}#${a.qname}`).find((d) => d.qname === a.qname);
          return [anchorKey(a), (!d ? "gone" : d.hash === a.hash ? "fresh" : "changed") satisfies AnchorState];
        }),
      );
    };
    const sessionFor = (cwd: string, model?: string): MemorySession => {
      session ??= new MemorySession({
        anchors: anchorsIn(cwd),
        memory: mem,
        // An Opera's threads share the Opera's memory, whichever repository they work in.
        cwd: host.memoryCwd ?? cwd,
        userSkillsDir: skillsDir(host.home),
        source: { agent: "mnemo", model },
        parentEpisode: host.parentEpisode,
        // A sub-agent's work is part of its parent's run, which reflects on the whole.
        // Off in the settings menu: no model call, and an empty reflection writes nothing.
        reflect: host.reflect && host.depth === 0 ? (system, user) => (host.settings.get().reflect ? reflector(system, user) : Promise.resolve("{}")) : undefined,
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
        // A run's lesson, kept only if the user says so: it is recalled into every later session.
        approveLesson: async (lesson, team) => {
          if (!host.ui) return false;
          const answer = await host.ui.approve({
            tool: team ? "Save team lesson" : "Save lesson",
            subject: lesson.cue,
            preview: [{ text: `+ ${lesson.lesson}`, tone: "add" as const }],
            reason: `${lesson.evidence ? `${lesson.evidence} ` : ""}(${lesson.confidence} confidence; kept in this project's memory, recalled at the start of later sessions)`,
          });
          return answer.kind !== "no";
        },
        skillsChanged: () => host.ui?.resourcesChanged(),
      });
      if (host.depth === 0) host.recalled = session.recalled;
      return session;
    };
    host.onModelChanged = async (model, reason) => {
      await session?.modelChanged(model, reason);
    };

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
          "A fact about one function, method or type: name it in code, and the fact is marked as possibly stale once that code changes. " +
          "Not for deferred work or the status of the current task: Mnemo records each session's open work itself.",
        parameters: Type.Object({
          scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
          key: Type.String(),
          value: Type.String(),
          code: Type.Optional(Type.String({ description: "The definition the fact is about: 'Cache.get', or 'src/cache.ts#Cache.get' when the name is not unique" })),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          let value = params.value;
          if (params.code) {
            const ix = await host.codeIndex?.(ctx.cwd);
            const unpinned = "Remember it without code, or name the definition in the value.";
            if (!ix) throw new Error(`The code index is off (/settings codeIndex), so a fact cannot be pinned to code. ${unpinned}`);
            if (typeof ix === "string") throw new Error(`${ix} So a fact cannot be pinned to code here. ${unpinned}`);
            const defs = ix.lookup(params.code).filter((d) => d.kind !== "module");
            if (!defs.length) throw new Error(`No definition named ${params.code} in the code index. code_search finds its name. ${unpinned}`);
            if (defs.length > 1)
              throw new Error(`${params.code} names ${defs.length} definitions: ${defs.slice(0, 6).map((d) => `${d.path}#${d.qname}`).join(", ")}. Give one as path#name.`);
            const d = defs[0]!;
            value = `${value} ${anchorTag({ path: d.path, qname: d.qname, hash: d.hash })}`;
          }
          const r = await sessionFor(ctx.cwd).remember(params.scope, params.key, value);
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
          const recorded = await sessionFor(ctx.cwd).steer(params.failure);
          if (!recorded) throw new Error("memory could not record this (it is not reachable, or no run is in progress)");
          return { content: [{ type: "text", text: "Recorded." }], details: {} };
        },
      }),
    );

    pi.on("before_agent_start", async (event, ctx) => {
      try {
        const s = sessionFor(ctx.cwd, ctx.model?.id);
        const r = await s.recall(event.prompt, pi.getActiveTools());
        host.episode = s.episode;
        // A section, not a returned systemPrompt: that would be a forced prompt, and every section an
        // extension loaded after this one sets would be dropped from it.
        event.systemPromptOptions.sections.memory = r.system.trim();
        return r.message ? { message: { customType: "mnemo-recall", content: r.message, display: false } } : undefined;
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
      const nudge = host.verify && host.settings.get().verify && host.depth === 0 && last.stopReason !== "error" ? await s.verifyNudge() : undefined;
      host.verifying = !!nudge;
      if (nudge) {
        held = messages;
        pi.sendMessage({ customType: "mnemo-verify", content: nudge, display: true }, { triggerTurn: true });
        return;
      }
      held = [];
      if (ctx.model) reflectWith = { model: ctx.model, sessionId: ctx.sessionManager.getSessionId() };
      const runId = host.roster.get(host.node)?.run;
      const run = { messages, signals: host.signals.splice(0), team: runId ? boardOf(host.roster, host.home).record(runId) : "" };
      inBackground(host, () => s.end(run));
    });

    // Memory grows duplicates, facts about files that are gone and memories marked wrong; a root
    // session clears them out in the background, as `mnemo memory tidy --apply` would.
    pi.on("session_start", async (_event, ctx) => {
      if (host.depth > 0 || !host.settings.get().tidyMemory) return;
      inBackground(host, async () => {
        const retired = await tidyWhenDue(mem, host.home, ctx.cwd);
        if (retired?.length)
          host.ui?.note({ kind: "session", text: `Tidied memory: retired ${retired.length} (kept as history)`, items: retired.map((t) => redact(`${t.why} · ${t.what}`)) });
      });
    });

    pi.on("session_shutdown", async () => {
      if (host.depth > 0) return;
      await session?.close();
    });
  };
}
