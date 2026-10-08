/**
 * A Hermes-Agent-style memory, for comparison only — not part of Mnemo.
 *
 * What it reproduces, from Hermes Agent's documented built-in memory
 * (hermes-agent.nousresearch.com/docs/user-guide/features/memory, read
 * 2026-10-08), on the same pi loop and model Mnemo runs on:
 *
 *   - two files: MEMORY.md (the agent's notes, 2,200 chars) and USER.md
 *     (the user profile, 1,375 chars), entries separated by "§"; global, not
 *     per project
 *   - both injected into the system prompt once per session, as a frozen
 *     snapshot with a usage header; writes during a session reach the disk at
 *     once and the prompt next session
 *   - a `memory` tool: add / replace / remove (by unique substring), the cap
 *     enforced with an error that lists the current entries; exact duplicates
 *     refused
 *   - a background review after the session (Hermes reviews every N user
 *     turns and flushes on exit; these eval sessions are one prompt long, so
 *     it runs at the end of each — the generous reading)
 *
 * Not reproduced: session search (FTS5), Honcho, the skill curator. Skills
 * are the same in both arms (Mnemo's create_skill tool is present in each).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textOf } from "@mnemo/memory";
import type { Host } from "../src/extensions/host.ts";
import { inBackground } from "../src/extensions/host.ts";

export const LIMITS = { memory: 2200, user: 1375 } as const;
type Target = keyof typeof LIMITS;
const SEP = "\n§\n";

export class HermesStore {
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  private file(t: Target) {
    return path.join(this.dir, t === "memory" ? "MEMORY.md" : "USER.md");
  }
  entries(t: Target): string[] {
    try {
      return fs
        .readFileSync(this.file(t), "utf8")
        .split(SEP)
        .map((e) => e.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  private save(t: Target, entries: string[]) {
    fs.writeFileSync(this.file(t), entries.join(SEP));
  }
  size(entries: string[]) {
    return entries.join(SEP).length;
  }
  /** One operation, applied only when the result fits; the error says what is there. */
  apply(t: Target, action: string, content = "", oldText = ""): string {
    const entries = this.entries(t);
    let next = entries;
    if (action === "add") {
      if (!content.trim()) throw new Error("content is required");
      if (entries.includes(content.trim())) return "Already saved.";
      next = [...entries, content.trim()];
    } else if (action === "replace" || action === "remove") {
      const hits = entries.filter((e) => e.includes(oldText));
      if (!oldText || hits.length !== 1) throw new Error(`old_text must match exactly one entry (matched ${hits.length})`);
      next = action === "remove" ? entries.filter((e) => e !== hits[0]) : entries.map((e) => (e === hits[0] ? content.trim() : e));
    } else throw new Error(`unknown action ${action}`);
    if (this.size(next) > LIMITS[t])
      throw new Error(
        `${t === "memory" ? "MEMORY.md" : "USER.md"} would be ${this.size(next)}/${LIMITS[t]} chars. Free room first (replace or remove). current_entries:\n${entries.map((e) => `- ${e}`).join("\n")}`,
      );
    this.save(t, next);
    return `${action} ok (${this.size(next)}/${LIMITS[t]} chars)`;
  }
  snapshot(): string {
    const block = (t: Target, title: string) => {
      const e = this.entries(t);
      const used = this.size(e);
      return `══ ${title} [${Math.round((used / LIMITS[t]) * 100)}% — ${used}/${LIMITS[t]} chars] ══\n${e.join("\n§\n") || "(empty)"}`;
    };
    return `${block("memory", "MEMORY (your personal notes)")}\n\n${block("user", "USER PROFILE")}`;
  }
}

const GUIDANCE = [
  "",
  "## Memory",
  "You have persistent memory across sessions: MEMORY.md (your notes on the environment, projects, conventions and lessons learned) and USER.md (who the user is and how they like to work). Both are shown below as they were when this session started.",
  "Save proactively with the memory tool whenever you learn something durable: user preferences, corrections, project conventions, commands that work, pitfalls and their fixes. Keep entries short; memory is small, so replace or remove stale entries when it fills up.",
].join("\n");

const REVIEW = `You maintain an AI coding agent's persistent memory: MEMORY.md (agent notes: environment, project conventions, commands, lessons, pitfalls) and USER.md (the user's preferences). Review the conversation and consider what to save. Return JSON only:
{"ops": [{"target": "memory"|"user", "action": "add"|"replace"|"remove", "content": "...", "old_text": "..."}]}
Save durable facts and lessons a future session would need; skip anything already saved. Keep entries short. Memory is capped (MEMORY.md ${LIMITS.memory} chars, USER.md ${LIMITS.user} chars): when it is near full, replace or remove stale entries. Use {"ops": []} when nothing is worth saving.`;

export function hermesExtension(host: Host, store: HermesStore) {
  return (pi: ExtensionAPI): void => {
    let frozen: string | undefined;
    pi.registerTool(
      defineTool({
        name: "memory",
        label: "Memory",
        description:
          "Persistent memory. target 'memory' (MEMORY.md: environment, project conventions, lessons) or 'user' (USER.md: the user's preferences). " +
          "action add (content), replace (old_text: a unique substring of the entry, content) or remove (old_text). Memory is capped; free room when it is full.",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
          target: Type.Union([Type.Literal("memory"), Type.Literal("user")]),
          content: Type.Optional(Type.String()),
          old_text: Type.Optional(Type.String()),
        }),
        async execute(_id, p) {
          const text = store.apply(p.target, p.action, p.content, p.old_text);
          host.ui?.note({ kind: "learned", items: [`${p.target} · ${p.action}: ${p.content ?? p.old_text ?? ""}`] });
          return { content: [{ type: "text", text }], details: {} };
        },
      }),
    );
    pi.on("before_agent_start", async (event) => {
      frozen ??= `${GUIDANCE}\n\n${store.snapshot()}`;
      return { systemPrompt: event.systemPrompt + frozen };
    });
    pi.on("agent_end", async (event, ctx) => {
      const model = ctx.model;
      if (!model || !host.reflect) return;
      const sessionId = ctx.sessionManager.getSessionId();
      const transcript = event.messages
        .map((m) => {
          const msg = m as { role: string; content?: unknown };
          return msg.role === "user" || msg.role === "assistant" ? `${msg.role.toUpperCase()}: ${textOf(msg.content).slice(0, 2000)}` : "";
        })
        .filter(Boolean)
        .join("\n")
        .slice(0, 9000);
      inBackground(host, async () => {
        const answer = await host.modelRuntime.completeSimple(
          model,
          { systemPrompt: REVIEW, messages: [{ role: "user", content: `CURRENT MEMORY:\n${store.snapshot()}\n\nCONVERSATION:\n${transcript}`, timestamp: Date.now() }] },
          { sessionId },
        );
        if (answer.stopReason === "error") return;
        const json = /\{[\s\S]*\}/.exec(textOf(answer.content))?.[0];
        if (!json) return;
        let ops: { target?: string; action?: string; content?: string; old_text?: string }[] = [];
        try {
          ops = (JSON.parse(json) as { ops?: typeof ops }).ops ?? [];
        } catch {
          return;
        }
        const done: string[] = [];
        for (const op of ops.slice(0, 8)) {
          try {
            store.apply(op.target === "user" ? "user" : "memory", op.action ?? "add", op.content, op.old_text);
            done.push(`${op.target} · ${op.action}: ${op.content ?? op.old_text}`);
          } catch {
            /* a rejected op is what Hermes' review would see as a tool error */
          }
        }
        if (done.length) host.ui?.note({ kind: "learned", items: done });
      });
    });
  };
}
