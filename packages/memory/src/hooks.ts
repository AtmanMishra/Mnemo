/**
 * Memory in Claude Code, through its command hooks. Each hook is one short
 * process with the event's JSON on stdin; nothing is kept between them:
 *
 *   SessionStart       the project and user profiles and the last session
 *                      (also after /clear, resume and compaction, which
 *                      fire it again — so memory survives a compaction)
 *   UserPromptSubmit   what search finds for this prompt: pitfalls with
 *                      their fixes, earlier sessions, skills
 *   Stop               (async) the session's transcript is ingested: the
 *                      run that just ended is reflected on and learned
 *
 * Context goes back as `hookSpecificOutput.additionalContext`, which Claude
 * Code caps at 10,000 characters.
 */
import type { MemoryService } from "./service.ts";
import { MemorySession } from "./session.ts";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
}

export interface HookOptions {
  memory: MemoryService;
  userSkillsDir: string;
}

const LIMIT = 9500;

function output(event: string, context: string | undefined): string | undefined {
  if (!context?.trim()) return undefined;
  const text = context.length > LIMIT ? `${context.slice(0, LIMIT)}\n…` : context;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** What a context hook prints, or nothing. `Stop` is not handled here: it needs a model. */
export async function contextHook(input: HookInput, o: HookOptions): Promise<string | undefined> {
  const event = input.hook_event_name ?? "";
  if (!input.cwd) return undefined;
  const session = new MemorySession({ memory: o.memory, cwd: input.cwd, userSkillsDir: o.userSkillsDir });
  if (event === "SessionStart") {
    const r = await session.context("", { lastSession: true });
    return output(event, [r.system.replace(/memory_remember|memory_search/g, (t) => `${t} (the mnemo MCP tools, when connected)`).trim(), r.message].filter(Boolean).join("\n\n"));
  }
  if (event === "UserPromptSubmit" && input.prompt) {
    const r = await session.context(input.prompt);
    return output(event, r.message);
  }
  return undefined;
}
