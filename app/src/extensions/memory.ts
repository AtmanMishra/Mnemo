/**
 * The memory loop, as a pi extension.
 *
 *   before each run   the project and user profiles go into the system
 *                     prompt — stable, so the cached prefix survives (audit
 *                     F3); what search finds for *this* message, plus the
 *                     last session's open threads on the first run, goes in
 *                     a message after it. Recalled knowledge (never Mnemo's
 *                     own markers — F4) is linked to the episode as a feeder
 *   during the run    every tool call is logged with its subject; a failure
 *                     steers memory once per distinct failure, counted across
 *                     sessions on one marker (F5), with no gap node (F6)
 *   after the run     reused recall earns a usefulness vote (F14); a clean
 *                     run reinforces its feeders; then one grounded
 *                     reflection call writes the session record (F11), the
 *                     durable facts the user stated or a tool showed (F16),
 *                     the fixes that resolved failures (F21), and — when a
 *                     reusable procedure was shown — a skill (L3)
 *   (no lexical consolidation at shutdown: its lessons were token bags that
 *    only added noise to recall — audit F7; lessons return when a model
 *    writes them as sentences, Phase D)
 *
 * Everything written is attached to the project (F10, F12). Memory never
 * breaks the loop: every call is best-effort.
 */
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { factValue, factsOf, type Hit, type ProfileFact } from "../memory/service.ts";
import { projectIdentity, type ProjectIdentity } from "../memory/project.ts";
import { Credit } from "../memory/credit.ts";
import { digest, parseReflection, REFLECT_PROMPT, textOf, worthReflecting, type Reflection, type ToolEvent } from "../memory/reflect.ts";
import { saveSkill } from "./skills.ts";
import { inBackground, type Host } from "./host.ts";

export const DIRECTIVE = [
  "",
  "## Memory",
  "You have a persistent memory that outlives this conversation. What it knows about this project and this user is below; anything else relevant to a message arrives with that message.",
  "- Treat recalled items as candidates, not facts: use what fits, ignore what does not.",
  "- When you learn something durable (a convention, a command, a preference, a decision, a pitfall), store it with memory_remember. Use a short stable key; the same key again replaces the old value.",
  "- Search with memory_search before saying you do not know something about this project.",
  "- A recalled pitfall's fix comes first: apply it before the command it is about instead of reproducing the failure.",
  "- Open items from the last session are agreed next steps: when the user asks to continue, do them.",
  "- Remember only what stays true. Work deferred to later, or an instruction tied to now (\"not yet\", \"until next session\"), is not a fact: the session record already carries open work.",
].join("\n");

/** How many facts per profile go into the prompt: the newest win (audit F13). */
const PROFILE_BUDGET = 40;

function factLines(facts: ProfileFact[]): string {
  return facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
}

/** The system-prompt block: directive + profiles. Changes only when a profile does. */
export function profileBlock(project: ProfileFact[], user: ProfileFact[], projectName: string): string {
  const parts = [DIRECTIVE];
  const p = project.filter((f) => f.key !== "last session").slice(-PROFILE_BUDGET);
  if (p.length) parts.push("", `### This project (${projectName})`, factLines(p));
  const u = user.slice(-PROFILE_BUDGET);
  if (u.length) parts.push("", "### This user", factLines(u));
  return parts.join("\n");
}

/** One recalled node, as the model reads it. */
export function describeHit(h: Hit): string {
  const facts = factsOf(h.state);
  const seen = factValue(h.state, "occurrences");
  if (h.area === "Salience") {
    const failure = factValue(h.state, "failure") ?? h.label.replace(/^pain: /, "");
    return `- pitfall: ${failure}${seen && seen !== "1" ? ` (seen ${seen}×)` : ""}\n  fix: ${factValue(h.state, "fix")}`;
  }
  if (h.kind === "TaskEpisode") {
    const get = (k: string) => factValue(h.state, k);
    return `- earlier session: ${get("goal")} — ${get("outcome") ?? "?"}${get("done") ? `\n  did: ${get("done")}` : ""}${get("open") ? `\n  left open: ${get("open")}` : ""}`;
  }
  return `- ${h.label}${facts.length ? `\n${facts.slice(0, 6).map((f) => `  ${f.key}: ${f.value}`).join("\n")}` : ""}`;
}

export function recallMessage(hits: Hit[], lastSession?: string): string {
  const parts = ["## From memory, for this message (candidates, not facts)"];
  if (lastSession) parts.push(`Last session: ${lastSession}`);
  for (const h of hits) parts.push(describeHit(h));
  return parts.join("\n");
}

const REFUSAL = /declined this call|Refused by a rule|Plan mode is read-only/;

function subjectOf(args: Record<string, unknown>): string {
  return String(args.command ?? args.path ?? args.pattern ?? args.query ?? args.task ?? args.name ?? "").split("\n")[0]!.slice(0, 200);
}

export function memoryExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const mem = host.memory;
    if (!mem) return;
    let identity: ProjectIdentity | undefined;
    let project: number | undefined;
    let userNode: number | undefined;
    let episode: number | undefined;
    let creating: Promise<number | undefined> | undefined;
    let profileText: string | undefined;
    let firstRun = true;
    const linked = new Set<number>();
    const painBySubject = new Map<string, number>();
    const credit = new Credit();
    let toolLog: ToolEvent[] = [];
    const subjects = new Map<string, { tool: string; subject: string }>();
    const files = new Set<string>();
    const skillsRead = new Set<string>();
    let runFailed = false;

    const ensureEpisode = (label: string): Promise<number | undefined> => {
      if (episode !== undefined) return Promise.resolve(episode);
      creating ??= (async () => {
        const id = await mem.episode(`task: ${label.replace(/\s+/g, " ").slice(0, 80)}`);
        if (id !== undefined) {
          if (project !== undefined) await mem.link(id, project, "part_of");
          if (host.parentEpisode !== undefined) await mem.link(id, host.parentEpisode, "part_of");
          episode = id;
          host.episode = id;
        }
        return id;
      })();
      return creating;
    };

    const steer = async (failure: string, subjectKey?: string) => {
      if (episode === undefined) return;
      const r = await mem.steer(episode, failure);
      if (!r?.pain_node) return;
      if (subjectKey) painBySubject.set(subjectKey, r.pain_node);
      if (project !== undefined) await mem.link(r.pain_node, project, "part_of");
      const n = r.occurrences ?? 1;
      host.ui?.note({ kind: "steer", text: n > 1 ? `has seen this failure ${n} times` : "noted the failure for next time" });
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
        async execute(_id, params) {
          const hits = await mem.search(params.query, params.k ?? 5, project);
          const body = hits.length ? hits.map(describeHit).join("\n") : "Nothing in memory matches.";
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
          "Use a short stable key; the same key again replaces the old value (kept as history). " +
          "Not for deferred work or the status of the current task: Mnemo records each session's open work itself.",
        parameters: Type.Object({
          scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
          key: Type.String(),
          value: Type.String(),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          identity ??= projectIdentity(ctx.cwd);
          if (params.key.toLowerCase() === "last session") throw new Error("\"last session\" is written by Mnemo from the session record; choose another key");
          const r = await mem.learn(params.scope, identity.id, params.key.toLowerCase(), params.value);
          if (!r) throw new Error("memory is not reachable");
          profileText = undefined;
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
      toolLog = [];
      files.clear();
      skillsRead.clear();
      try {
        identity ??= projectIdentity(ctx.cwd);
        project ??= await mem.project(identity.id, identity.root);
        userNode ??= await mem.userNode();
        const ep = await ensureEpisode(event.prompt);
        const profiles = [project, userNode].filter((n): n is number => n !== undefined);
        const [projectFacts, userFacts, hits] = await Promise.all([
          mem.profile("project", identity.id),
          mem.profile("user", identity.id),
          mem.recall(event.prompt, project, profiles),
        ]);
        // The profiles are what this session's knowledge rests on: link them
        // as feeders once, so a failure can blame them and a success credit them.
        const knowledge = [...profiles, ...hits.filter((h) => h.area !== "Salience" && h.kind !== "TaskEpisode").map((h) => h.node)];
        if (ep !== undefined)
          for (const node of knowledge)
            if (!linked.has(node)) {
              linked.add(node);
              await mem.link(node, ep);
            }
        credit.recalled(
          hits.map((h) => ({ node: h.node, text: `${h.label} ${factsOf(h.state).map((f) => `${f.key} ${f.value}`).join(" ")}` })),
          event.prompt,
        );
        const lastSession = firstRun ? projectFacts.find((f) => f.key === "last session")?.value : undefined;
        firstRun = false;
        profileText ??= profileBlock(projectFacts, userFacts, identity.name);
        const items = [
          ...(projectFacts.length ? [`${projectFacts.length} fact${projectFacts.length === 1 ? "" : "s"} about ${identity.name}`] : []),
          ...(userFacts.length ? [`${userFacts.length} preference${userFacts.length === 1 ? "" : "s"}`] : []),
          ...(lastSession ? [`last session: ${lastSession}`] : []),
          ...hits.map((h) =>
            h.area === "Salience" ? `pitfall: ${h.label.replace(/^pain: /, "")}` : h.kind === "TaskEpisode" ? `earlier: ${factValue(h.state, "goal")}` : h.label,
          ),
        ];
        if (items.length) host.ui?.note({ kind: "recall", items });
        return {
          systemPrompt: event.systemPrompt + profileText,
          ...(hits.length || lastSession
            ? { message: { customType: "mnemo-recall", content: recallMessage(hits, lastSession), display: false } }
            : {}),
        };
      } catch {
        return undefined;
      }
    });

    pi.on("tool_execution_start", async (event) => {
      const args = (event.args ?? {}) as Record<string, unknown>;
      subjects.set(event.toolCallId, { tool: event.toolName, subject: subjectOf(args) });
      if (event.toolName === "read" && typeof args.path === "string" && args.path.endsWith("SKILL.md"))
        skillsRead.add(path.basename(path.dirname(args.path)));
      for (const node of credit.observe(JSON.stringify(args))) void mem.markUseful(node).catch(() => {});
    });

    pi.on("tool_execution_end", async (event) => {
      const s = subjects.get(event.toolCallId) ?? { tool: event.toolName, subject: "" };
      subjects.delete(event.toolCallId);
      const error = event.isError ? textOf((event.result as { content?: unknown })?.content).slice(0, 400) : undefined;
      if (!event.isError && (s.tool === "edit" || s.tool === "write") && s.subject) files.add(s.subject);
      const refused = !!error && REFUSAL.test(error);
      if (!refused) toolLog.push({ tool: s.tool, subject: s.subject, ok: !event.isError, error });
      if (episode === undefined) return;
      try {
        await mem.log(
          episode,
          event.isError ? "tool_error" : "tool_call",
          `${s.tool}(${s.subject.slice(0, 120)})${event.isError ? `: ${error?.split("\n")[0]}` : ""}`,
        );
        if (event.isError && !refused) {
          runFailed = true;
          await steer(`${s.tool} failed: ${error?.split("\n").slice(0, 3).join(" ").slice(0, 300)}`, `${s.tool}(${s.subject})`);
        }
      } catch {
        /* memory never breaks the loop */
      }
    });

    pi.on("turn_end", async (event) => {
      const m = event.message as { stopReason?: string; errorMessage?: string; content?: unknown };
      for (const node of credit.observe(textOf(m.content))) void mem.markUseful(node).catch(() => {});
      if (m.stopReason === "error") {
        runFailed = true;
        await steer(m.errorMessage ?? "the model call failed").catch(() => {});
      }
    });

    pi.on("agent_end", async (event, ctx) => {
      const last = [...event.messages].reverse().find((m) => (m as { role: string }).role === "assistant") as
        | { stopReason?: string }
        | undefined;
      if (!last || last.stopReason === "aborted") return;
      const ep = episode;
      const model = ctx.model;
      const sessionId = ctx.sessionManager.getSessionId();
      const signals = host.signals.splice(0);
      const run = { messages: event.messages, tools: toolLog, files: [...files], signals };
      const usedSkills = [...skillsRead];
      const failed = runFailed;
      inBackground(host, async () => {
        if (ep !== undefined && !failed) await mem.good(ep, "run completed without errors");
        for (const name of usedSkills) {
          const node = await mem.findLabel(`skill ${name}`);
          if (node !== undefined) await mem.log(node, "used", `episode #${ep}: ${failed ? "had failures" : "clean"}`);
        }
        // A sub-agent's work is part of its parent's run, which reflects on the whole.
        if (!host.reflect || !model || host.depth > 0 || !identity || !worthReflecting(run)) return;
        const [projectFacts, userFacts] = await Promise.all([mem.profile("project", identity.id), mem.profile("user", identity.id)]);
        const known = [...projectFacts.map((f) => `project · ${f.key}: ${f.value}`), ...userFacts.map((f) => `user · ${f.key}: ${f.value}`)];
        // The session id routes the call like the session's own (OpenCode refuses one without it).
        const answer = await host.modelRuntime.completeSimple(
          model,
          {
            systemPrompt: REFLECT_PROMPT,
            messages: [{ role: "user", content: `KNOWN:\n${known.join("\n") || "(nothing yet)"}\n\nRUN:\n${digest(run)}`, timestamp: Date.now() }],
          },
          { sessionId },
        );
        if (answer.stopReason === "error") {
          host.ui?.note({ kind: "failed", text: `Reflection failed: ${answer.errorMessage ?? "no answer"}` });
          return;
        }
        await applyReflection(parseReflection(textOf(answer.content)), { projectFacts, userFacts, ep });
      });
    });

    /** Write what one reflection found. Kept separate so its rules read in one place. */
    const applyReflection = async (r: Reflection, ctx: { projectFacts: ProfileFact[]; userFacts: ProfileFact[]; ep: number | undefined }) => {
      if (!identity) return;
      const learned: string[] = [];
      // Facts: only what the user said or a tool showed; a guess is not memory.
      const known = new Map<string, string>([
        ...ctx.projectFacts.map((f): [string, string] => [`project:${f.key}`, f.value]),
        ...ctx.userFacts.map((f): [string, string] => [`user:${f.key}`, f.value]),
      ]);
      for (const f of r.facts) {
        if (f.source === "inferred" || known.get(`${f.scope}:${f.key}`) === f.value) continue;
        await mem.learn(f.scope, identity.id, f.key, f.value);
        learned.push(`${f.scope} · ${f.key}: ${f.value}`);
      }
      if (learned.length) {
        profileText = undefined;
        host.ui?.note({ kind: "learned", items: learned });
      }
      // The session record, on the episode; and the latest one, on the project.
      if (r.episode && ctx.ep !== undefined) {
        const e = r.episode;
        await mem.fact(ctx.ep, "goal", e.goal);
        await mem.fact(ctx.ep, "outcome", e.outcome);
        if (e.done) await mem.fact(ctx.ep, "done", e.done);
        if (e.decisions.length) await mem.fact(ctx.ep, "decisions", e.decisions.join("; "));
        if (e.open.length) await mem.fact(ctx.ep, "open", e.open.join("; "));
        const day = new Date().toISOString().slice(0, 10);
        await mem.learn("project", identity.id, "last session", `${day}: ${e.goal} — ${e.outcome}${e.open.length ? `; open: ${e.open.join("; ")}` : ""}`);
        host.ui?.note({ kind: "session", text: `Session ${e.outcome}`, items: [e.goal, ...(e.open.length ? [`open: ${e.open.join("; ")}`] : [])] });
      }
      // Fixes: attach to the failure's marker when we know it; otherwise a pitfall of its own.
      const fixed: string[] = [];
      for (const f of r.fixes) {
        const words = f.problem.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        const matched = [...painBySubject.entries()].find(([subject]) => words.some((w) => subject.toLowerCase().includes(w)))?.[1];
        let node = matched ?? (painBySubject.size === 1 ? [...painBySubject.values()][0] : undefined);
        if (node === undefined) {
          node = await mem.createNode("aspect", `pain: ${f.problem.slice(0, 60)}`, "salience");
          if (node !== undefined) {
            await mem.fact(node, "failure", f.problem);
            if (project !== undefined) await mem.link(node, project, "part_of");
          }
        }
        if (node !== undefined) {
          await mem.fact(node, "fix", f.fix);
          fixed.push(`${f.problem} → ${f.fix}`);
        }
      }
      if (fixed.length) host.ui?.note({ kind: "learned", items: fixed.map((x) => `fix · ${x}`) });
      if (r.skill) await proposeSkill(r.skill);
    };

    /**
     * A procedure the run demonstrated. Saved when the user asked for it, or
     * when the same procedure has now been seen in two sessions; otherwise
     * kept as a candidate. Saving goes through the approval dialog with the
     * file itself as the preview; without an interface nothing is written.
     */
    const proposeSkill = async (s: NonNullable<Reflection["skill"]>) => {
      if (!identity) return;
      const candidateLabel = `skill candidate ${s.name}`;
      let candidate = await mem.findLabel(candidateLabel);
      let seen = 1;
      if (candidate === undefined) {
        candidate = await mem.createNode("harness", candidateLabel, "procedural");
        if (candidate !== undefined && project !== undefined) await mem.link(candidate, project, "part_of");
      } else {
        seen = Number(factValue(await mem.state(candidate), "seen") ?? "1") + 1;
      }
      if (candidate !== undefined) {
        await mem.fact(candidate, "seen", String(seen));
        await mem.fact(candidate, "description", s.description);
        await mem.fact(candidate, "instructions", s.instructions.slice(0, 1500));
      }
      if ((await mem.findLabel(`skill ${s.name}`)) !== undefined) return;
      if (!s.explicit && seen < 2) return;
      if (!host.ui) return;
      const file = saveSkill.target(host.home, identity.root, s.scope, s.name);
      const body = saveSkill.render(s.name, s.description, s.instructions);
      const answer = await host.ui.approve({
        tool: "Save skill",
        subject: file,
        preview: body.split("\n").map((text) => ({ text: `+ ${text}`, tone: "add" as const })),
        reason: s.explicit ? "you asked Mnemo to remember how to do this" : `Mnemo has now done this procedure in ${seen} sessions`,
      });
      if (answer.kind === "no") return;
      saveSkill.write(file, body);
      const node = await mem.createNode("harness", `skill ${s.name}`, "procedural");
      if (node !== undefined) {
        await mem.fact(node, "use when", s.description);
        await mem.fact(node, "file", file);
        if (s.scope === "project" && project !== undefined) await mem.link(node, project, "part_of");
      }
      host.ui.note({ kind: "skill", text: `saved skill ${s.name}` });
      host.ui.resourcesChanged();
    };

    pi.on("session_shutdown", async () => {
      if (host.depth > 0) return;
      try {
        if (episode !== undefined) await mem.log(episode, "outcome", "session ended");
      } catch {
        /* ignore */
      }
    });
  };
}
