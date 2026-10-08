/**
 * The memory loop, as a pi extension.
 *
 *   before each run   inject the project and user profiles, plus what search
 *                     finds for this message; link what was recalled to the
 *                     episode, so a later failure can blame it
 *   during the run    log every tool call into the episode; a failed call or a
 *                     failed turn *steers* the graph (pain marker, blame,
 *                     correction or gap) — once per distinct failure
 *   after the run     a clean run reinforces what fed it; then a small model
 *                     call reads the exchange and writes the durable facts it
 *                     contains onto the profiles (a changed fact supersedes)
 *   at shutdown       consolidate recurring episodes into lessons
 *
 * Memory never breaks the loop: every call is best-effort and a dead sidecar
 * means "no memory", not a failed turn.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Hit, MemoryService, ProfileFact, Scope } from "../memory/service.ts";
import { inBackground, type Host } from "./host.ts";

export const DIRECTIVE = [
  "",
  "## Memory",
  "You have a persistent memory that outlives this conversation. What it holds about this project and this user is below, with anything else that matched the message.",
  "- Treat recalled items as candidates, not facts: use what fits, ignore what does not.",
  "- When you learn something durable (a convention, a command, a preference, a decision, a pitfall), store it with memory_remember. Use a short stable key; writing the same key again replaces the old value.",
  "- Search with memory_search before saying you do not know something about this project.",
].join("\n");

function factLines(facts: ProfileFact[]): string {
  return facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
}

export function memoryBlock(project: ProfileFact[], user: ProfileFact[], hits: Hit[]): string {
  const parts = [DIRECTIVE];
  if (project.length) parts.push("", "### This project", factLines(project));
  if (user.length) parts.push("", "### This user", factLines(user));
  if (hits.length) {
    parts.push("", "### Recalled for this message");
    for (const h of hits) {
      const facts = h.state
        .split("\n")
        .filter((l) => /^\s+- /.test(l))
        .slice(0, 5)
        .join("\n");
      parts.push(`- ${h.label} [${h.area}]${facts ? `\n${facts}` : ""}`);
    }
  }
  return parts.join("\n");
}

type Msg = { role: string; content?: unknown; toolName?: string; isError?: boolean; stopReason?: string };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/** One run, condensed for the reflection call: what was asked, done, answered, and what failed. */
export function digest(messages: readonly unknown[], max = 6000): string {
  const out: string[] = [];
  for (const raw of messages) {
    const m = raw as Msg;
    if (m.role === "user") out.push(`USER: ${text(m.content).slice(0, 1200)}`);
    else if (m.role === "assistant") {
      const t = text(m.content).trim();
      if (t) out.push(`ASSISTANT: ${t.slice(0, 1200)}`);
      for (const c of (Array.isArray(m.content) ? m.content : []) as { type: string; name?: string; arguments?: Record<string, unknown> }[]) {
        if (c.type === "toolCall") {
          const a = c.arguments ?? {};
          out.push(`TOOL ${c.name}(${String(a.command ?? a.path ?? a.pattern ?? "").slice(0, 160)})`);
        }
      }
    } else if (m.role === "toolResult" && m.isError) out.push(`TOOL FAILED (${m.toolName}): ${text(m.content).slice(0, 300)}`);
  }
  const all = out.join("\n");
  return all.length > max ? `${all.slice(0, max)}\n…` : all;
}

export const REFLECT_PROMPT = `You maintain the long-term memory of a coding agent called Mnemo.
Read the exchange and extract only DURABLE facts that will still be true and useful in future sessions:
- scope "user": the user's preferences and working style (true in every project)
- scope "project": this codebase — stack, commands, conventions, structure, decisions, pitfalls
Skip anything transient, specific to this one task, or a guess. Prefer the user's own statements.
Use short, stable, lowercase keys ("package manager", "test command", "comment style") so that a
changed fact replaces the old one. If a fact below is now wrong, emit the same key with the new value.
Answer with JSON only: {"facts":[{"scope":"project"|"user","key":"...","value":"..."}]} — an empty list when nothing is durable.`;

export interface LearnedFact {
  scope: Scope;
  key: string;
  value: string;
}

/** Parse the reflection answer; anything malformed is "nothing learned". */
export function parseFacts(answer: string): LearnedFact[] {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(answer.slice(start, end + 1)) as { facts?: unknown };
    if (!Array.isArray(parsed.facts)) return [];
    return parsed.facts
      .filter((f): f is LearnedFact => {
        const x = f as Partial<LearnedFact>;
        return (x.scope === "project" || x.scope === "user") && typeof x.key === "string" && typeof x.value === "string";
      })
      .map((f) => ({ scope: f.scope, key: f.key.trim().toLowerCase().slice(0, 60), value: f.value.trim().slice(0, 300) }))
      .filter((f) => f.key && f.value)
      .slice(0, 6);
  } catch {
    return [];
  }
}

export function memoryExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const mem = host.memory;
    if (!mem) return;
    let episode: number | undefined;
    let creating: Promise<number | undefined> | undefined;
    const linked = new Set<number>();
    const steered = new Set<string>();
    let runFailed = false;

    const ensureEpisode = (label: string): Promise<number | undefined> => {
      if (episode !== undefined) return Promise.resolve(episode);
      creating ??= mem.episode(`task: ${label.replace(/\s+/g, " ").slice(0, 80)}`).then((id) => (episode = id));
      return creating;
    };

    const steer = async (failure: string) => {
      const sig = failure.slice(0, 200);
      if (episode === undefined || steered.has(sig)) return;
      steered.add(sig);
      const r = await mem.steer(episode, failure);
      if (r && host.ui) {
        const blamed = r.blamed_feeders?.length ?? 0;
        host.ui.note({
          kind: "steer",
          text: blamed ? `noted the failure; ${blamed} recalled item${blamed === 1 ? "" : "s"} lost weight` : "noted the failure for next time",
        });
      }
    };

    pi.registerTool(
      defineTool({
        name: "memory_search",
        label: "Memory search",
        description: "Search Mnemo's long-term memory (projects, preferences, past episodes, lessons, skills).",
        parameters: Type.Object({
          query: Type.String({ description: "What to look for, in plain words" }),
          k: Type.Optional(Type.Number({ description: "How many results (default 5)" })),
        }),
        async execute(_id, params) {
          const hits = await mem.search(params.query, params.k ?? 5);
          const body = hits.length
            ? hits.map((h) => `- ${h.label} [${h.area}, ${h.kind}]\n${h.state.split("\n").filter((l) => /^\s+- /.test(l)).join("\n")}`).join("\n")
            : "Nothing in memory matches.";
          return { content: [{ type: "text", text: body }], details: { hits: hits.map((h) => h.label) } };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "memory_remember",
        label: "Remember",
        description:
          "Store a durable fact in long-term memory. scope 'project' for facts about this codebase, 'user' for the user's preferences. " +
          "Use a short stable key; the same key again replaces the old value (kept as history).",
        parameters: Type.Object({
          scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
          key: Type.String(),
          value: Type.String(),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          const r = await mem.learn(params.scope, ctx.cwd, params.key.toLowerCase(), params.value);
          if (!r) throw new Error("memory is not reachable");
          host.ui?.note({ kind: "learned", items: [`${params.scope} · ${params.key}: ${params.value}`] });
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
        async execute(_id, params) {
          await steer(params.failure);
          return { content: [{ type: "text", text: "Recorded." }], details: {} };
        },
      }),
    );

    pi.on("before_agent_start", async (event, ctx) => {
      runFailed = false;
      try {
        const [project, user, hits] = await Promise.all([
          mem.profile("project", ctx.cwd),
          mem.profile("user", ctx.cwd),
          mem.recall(event.prompt, ctx.cwd),
        ]);
        const ep = await ensureEpisode(event.prompt);
        if (ep !== undefined)
          for (const h of hits)
            if (!linked.has(h.node)) {
              linked.add(h.node);
              await mem.link(h.node, ep);
            }
        const items = [
          ...(project.length ? [`${project.length} fact${project.length === 1 ? "" : "s"} about this project`] : []),
          ...(user.length ? [`${user.length} preference${user.length === 1 ? "" : "s"}`] : []),
          ...hits.map((h) => h.label),
        ];
        if (items.length) host.ui?.note({ kind: "recall", items });
        return { systemPrompt: event.systemPrompt + memoryBlock(project, user, hits) };
      } catch {
        return undefined;
      }
    });

    pi.on("tool_execution_end", async (event) => {
      if (episode === undefined) return;
      try {
        await mem.log(episode, "tool_call", `${event.toolName}: ${event.isError ? "error" : "ok"}`);
        if (event.isError) {
          runFailed = true;
          const why = text((event.result as { content?: unknown })?.content).slice(0, 300);
          // A refusal by the user or a rule is a decision, not a failure to learn from.
          if (!/declined this call|Refused by a rule|Plan mode is read-only/.test(why)) await steer(`${event.toolName} failed: ${why}`);
        }
      } catch {
        /* memory never breaks the loop */
      }
    });

    pi.on("turn_end", async (event) => {
      const m = event.message as Msg & { errorMessage?: string };
      if (m.stopReason === "error") {
        runFailed = true;
        await steer(m.errorMessage ?? "the model call failed").catch(() => {});
      }
    });

    pi.on("agent_end", async (event, ctx) => {
      const last = [...event.messages].reverse().find((m) => (m as Msg).role === "assistant") as Msg | undefined;
      if (!last || last.stopReason === "aborted" || last.stopReason === "error") return;
      const ep = episode;
      const model = ctx.model;
      inBackground(host, async () => {
        if (ep !== undefined && !runFailed) await mem.good(ep, "run completed without errors");
        // A sub-agent's work is part of its parent's run, which reflects on the whole.
        if (!host.reflect || !model || host.depth > 0) return;
        const exchange = digest(event.messages);
        if (exchange.length < 40) return;
        const [project, user] = await Promise.all([mem.profile("project", ctx.cwd), mem.profile("user", ctx.cwd)]);
        const known = [...project.map((f) => `project · ${f.key}: ${f.value}`), ...user.map((f) => `user · ${f.key}: ${f.value}`)];
        const answer = await host.modelRuntime.completeSimple(model, {
          systemPrompt: REFLECT_PROMPT,
          messages: [
            {
              role: "user",
              content: `Already known:\n${known.join("\n") || "(nothing yet)"}\n\nExchange:\n${exchange}`,
              timestamp: Date.now(),
            },
          ],
        });
        const facts = parseFacts(text(answer.content));
        const existing = new Map<string, string>([
          ...project.map((f): [string, string] => [`project:${f.key}`, f.value]),
          ...user.map((f): [string, string] => [`user:${f.key}`, f.value]),
        ]);
        const fresh = facts.filter((f) => existing.get(`${f.scope}:${f.key}`) !== f.value);
        for (const f of fresh) await mem.learn(f.scope, ctx.cwd, f.key, f.value);
        if (ep !== undefined) for (const f of fresh) await mem.fact(ep, `learned ${f.key}`, f.value);
        if (fresh.length) host.ui?.note({ kind: "learned", items: fresh.map((f) => `${f.scope} · ${f.key}: ${f.value}`) });
      });
    });

    pi.on("session_shutdown", async () => {
      if (host.depth > 0) return;
      try {
        if (episode !== undefined) await mem.log(episode, "outcome", "session ended");
        await mem.consolidate();
      } catch {
        /* ignore */
      }
    });
  };
}
