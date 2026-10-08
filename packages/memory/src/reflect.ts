/**
 * Session understanding: what one run of the agent is turned into.
 *
 * After a run, one model call reads a *grounded* digest — the user's words,
 * the answers, every tool call with its outcome, the failure→recovery pairs
 * found mechanically in the tool log, the files that changed, and anything
 * the user said in an approval dialog — and returns:
 *
 *   facts    durable knowledge for the project or user profile, each tagged
 *            with where it came from; only what the user said or what was
 *            observed is kept (a guess is not memory — audit F16)
 *   episode  the record of this session: goal, outcome, what was done,
 *            decisions, open threads (audit F11, "session understanding")
 *   fixes    problem → what resolved it (audit F21)
 *   skill    a reusable procedure worth saving, when one was demonstrated
 *
 * Pure: the prompt, the digest and the parser, so each is tested without a
 * model and tuned against a real one in `app/eval/`.
 */

export interface ToolEvent {
  tool: string;
  subject: string;
  ok: boolean;
  /** First lines of the error, when it failed. */
  error?: string;
}

export interface Recovery {
  failed: ToolEvent;
  /** The later successful call of the same tool (or a bash call) that came after. */
  then: ToolEvent[];
}

/**
 * Failure → what came next, found mechanically: for each failed call, the
 * successful calls that followed it before the next failure (at most three).
 * The model is asked to name the fix; this keeps it honest about what happened.
 */
export function recoveries(log: readonly ToolEvent[]): Recovery[] {
  const out: Recovery[] = [];
  for (let i = 0; i < log.length; i++) {
    const e = log[i]!;
    if (e.ok) continue;
    const then: ToolEvent[] = [];
    for (let j = i + 1; j < log.length && then.length < 3; j++) {
      if (!log[j]!.ok) break;
      then.push(log[j]!);
    }
    if (then.length) out.push({ failed: e, then });
  }
  return out;
}

type Msg = { role: string; content?: unknown };

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface DigestInput {
  messages: readonly unknown[];
  tools: readonly ToolEvent[];
  files: readonly string[];
  signals: readonly string[];
}

/** One run, condensed and grounded. Bounded so a long run costs a bounded call. */
export function digest(d: DigestInput, max = 9000): string {
  const parts: string[] = [];
  for (const raw of d.messages) {
    const m = raw as Msg;
    if (m.role === "user") parts.push(`USER: ${clip(textOf(m.content), 1500)}`);
    else if (m.role === "assistant") {
      const t = textOf(m.content).trim();
      if (t) parts.push(`ASSISTANT: ${clip(t, 1500)}`);
    }
  }
  if (d.tools.length) {
    parts.push("", "TOOL CALLS (in order):");
    for (const t of d.tools.slice(-40)) parts.push(`- ${t.tool}(${clip(t.subject, 140)}) → ${t.ok ? "ok" : `FAILED: ${clip(t.error ?? "", 200)}`}`);
  }
  const rec = recoveries(d.tools);
  if (rec.length) {
    parts.push("", "FAILURES AND WHAT FOLLOWED:");
    for (const r of rec.slice(-6))
      parts.push(`- ${r.failed.tool}(${clip(r.failed.subject, 100)}) failed: ${clip(r.failed.error ?? "", 160)}\n  then: ${r.then.map((t) => `${t.tool}(${clip(t.subject, 80)})`).join(", ")}`);
  }
  if (d.files.length) parts.push("", `FILES CHANGED: ${d.files.slice(0, 30).join(", ")}`);
  if (d.signals.length) parts.push("", "THE USER SAID IN APPROVAL DIALOGS:", ...d.signals.map((s) => `- ${s}`));
  const all = parts.join("\n");
  return all.length > max ? `${all.slice(0, max)}\n…` : all;
}

export const REFLECT_PROMPT = `You maintain the long-term memory of Mnemo, a coding agent. Read one run of a session and return JSON only.

{
  "facts": [{"scope": "project"|"user", "key": "...", "value": "...", "source": "user"|"observed"|"inferred"}],
  "episode": {"goal": "...", "outcome": "done"|"partial"|"failed"|"abandoned", "done": "...", "decisions": ["..."], "open": ["..."]},
  "fixes": [{"problem": "...", "fix": "..."}],
  "skill": null | {"name": "kebab-case", "scope": "project"|"user", "description": "when to use it", "instructions": "markdown steps", "explicit": true|false}
}

facts — only DURABLE knowledge still true next week, at most 5 per run: the ones a future session in this project would most regret not knowing:
  - scope "user": how this person likes to work (true in every project)
  - scope "project": this codebase's stack, commands, conventions, structure, decisions, pitfalls
  - source "user" if the user stated it, "observed" if a tool result showed it, "inferred" if you are guessing
  - corrections from the user ("no, use X", "don't do Y", a refusal with a reason) are the most important facts
  - short stable lowercase keys ("package manager", "test command"); when a KNOWN fact is about the same thing, reuse its key so the new value replaces it
  - when the run showed how this project checks its work (tests, typecheck, lint, build), record the exact command(s) under the key "verify command"
  - describe how things stand at the END of the run: if the run moved, renamed or replaced something, the old state is not a fact
  - never secrets, tokens, passwords or personal data; nothing about this one task's specifics
  - never what a quick look at the repository shows (a file's contents, an empty scripts object, what a module exports)
  - never deferred work or the state of this task ("not implemented yet", "X still needs adding", "do not do Y until later"): that is episode.open
episode — this session's record, in plain sentences: what the user wanted, how it ended, what was actually done (files, commands), choices made and why, what is left open. Base it ONLY on the transcript and tool calls.
fixes — for each failure that was later resolved: the problem in a few words and the concrete fix (a command, a change). At most 3. Skip failures that were not resolved, and slips in the agent's own tool use (an edit whose old text did not match, a file changed since it was read, a mistyped path it then corrected): they teach nothing about the project.
skill — propose one ONLY if the run demonstrated a multi-step procedure (3+ steps) likely to be repeated (setup, release, deploy, migration, a debugging routine), or the user asked to remember how to do something (then "explicit": true). Otherwise null.
Use empty lists when there is nothing. Output the JSON object and nothing else.`;

export interface LearnedFact {
  scope: "project" | "user";
  key: string;
  value: string;
  source: "user" | "observed" | "inferred";
}

export interface EpisodeRecord {
  goal: string;
  outcome: "done" | "partial" | "failed" | "abandoned";
  done: string;
  decisions: string[];
  open: string[];
}

export interface SkillProposal {
  name: string;
  scope: "project" | "user";
  description: string;
  instructions: string;
  explicit: boolean;
}

export interface Reflection {
  facts: LearnedFact[];
  episode?: EpisodeRecord;
  fixes: { problem: string; fix: string }[];
  skill?: SkillProposal;
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => str(x, n)).filter(Boolean).slice(0, 8) : []);

/** Parse the model's answer; anything malformed is dropped, never thrown. */
export function parseReflection(answer: string): Reflection {
  const empty: Reflection = { facts: [], fixes: [] };
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return empty;
  }
  const facts = (Array.isArray(raw.facts) ? raw.facts : [])
    .map((f: Record<string, unknown>) => ({
      scope: f.scope === "user" ? ("user" as const) : f.scope === "project" ? ("project" as const) : undefined,
      key: str(f.key, 60).toLowerCase(),
      value: str(f.value, 300),
      source: f.source === "user" || f.source === "observed" ? f.source : ("inferred" as const),
    }))
    .filter((f): f is LearnedFact => Boolean(f.scope && f.key && f.value))
    .slice(0, 8);
  const e = raw.episode as Record<string, unknown> | undefined;
  const outcomes = ["done", "partial", "failed", "abandoned"] as const;
  const episode: EpisodeRecord | undefined =
    e && str(e.goal, 300)
      ? {
          goal: str(e.goal, 300),
          outcome: outcomes.includes(e.outcome as (typeof outcomes)[number]) ? (e.outcome as EpisodeRecord["outcome"]) : "partial",
          done: str(e.done, 600),
          decisions: strs(e.decisions, 240),
          open: strs(e.open, 240),
        }
      : undefined;
  const fixes = (Array.isArray(raw.fixes) ? raw.fixes : [])
    .map((x: Record<string, unknown>) => ({ problem: str(x.problem, 200), fix: str(x.fix, 300) }))
    .filter((x) => x.problem && x.fix)
    .slice(0, 6);
  const k = raw.skill as Record<string, unknown> | null | undefined;
  const name = k ? str(k.name, 64).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") : "";
  const skill: SkillProposal | undefined =
    k && name && str(k.description, 300) && str(k.instructions, 6000)
      ? {
          name,
          scope: k.scope === "user" ? "user" : "project",
          description: str(k.description, 300),
          instructions: str(k.instructions, 6000),
          explicit: k.explicit === true,
        }
      : undefined;
  return { facts, episode, fixes, skill };
}

/** Is this run worth a reflection call? Small talk and one-line answers are not. */
export function worthReflecting(d: DigestInput): boolean {
  if (d.signals.length || d.tools.length >= 2) return true;
  const userText = d.messages
    .filter((m) => (m as Msg).role === "user")
    .map((m) => textOf((m as Msg).content))
    .join(" ");
  return userText.length >= 40 || /\b(remember|always|never|prefer|don't|do not|use)\b/i.test(userText);
}
