/**
 * How memory reads to a model: the standing directive and profiles (stable,
 * so they can sit in a cached system prompt — audit F3) and what was recalled
 * for one message (which travels with that message).
 */
import { factValue, factsOf, type Hit, type ProfileFact } from "./service.ts";

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

/** The short line a person sees for one recalled node. */
export function hitLine(h: Hit): string {
  return h.area === "Salience" ? `pitfall: ${h.label.replace(/^pain: /, "")}` : h.kind === "TaskEpisode" ? `earlier: ${factValue(h.state, "goal")}` : h.label;
}
